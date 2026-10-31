import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, tx, type Db } from '../db.ts';
import { HttpError } from '../errors.ts';
import { verifyGoogleToken } from '../lib/google.ts';
import { send } from '../lib/mailer.ts';
import { issueSession, publicSession, toUser, USER_COLUMNS, type UserRow } from '../lib/session.ts';
import { randomToken, sha256 } from '../lib/tokens.ts';
import { authenticate } from '../middleware/auth.ts';
import { forgotPasswordBody, googleBody, loginBody, patchMeBody, refreshBody, registerBody, resetPasswordBody } from '../schemas.ts';

export const authRouter = Router();
export const meRouter = Router();

// Hash de relleno para que login tarde parecido exista o no el correo.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= Bun.password.hash('no-such-user-password'));

/** Crea grupo + usuario en la misma transacción. Todo usuario pertenece a exactamente un grupo. */
async function createUserWithHousehold(c: Db, input: { email: string; displayName?: string | null }): Promise<UserRow> {
  const label = input.displayName?.trim() || input.email.split('@')[0]!;
  const hh = await c.query(`INSERT INTO households (name) VALUES ($1) RETURNING id`, [`Hogar de ${label}`]);
  const u = await c.query<UserRow>(
    `INSERT INTO users (household_id, household_role, email, display_name) VALUES ($1, 'owner', $2, $3) RETURNING ${USER_COLUMNS}`,
    [hh.rows[0].id, input.email, input.displayName?.trim() || null],
  );
  return u.rows[0]!;
}

authRouter.post('/register', async (req, res) => {
  const b = registerBody.parse(req.body);
  const hash = await Bun.password.hash(b.password);
  const out = await tx(async (c) => {
    const taken = await c.query(`SELECT 1 FROM users WHERE email = $1`, [b.email]);
    if (taken.rowCount) throw new HttpError(409, 'email_taken', 'Ya existe una cuenta con ese correo');
    const user = await createUserWithHousehold(c, b);
    await c.query(`INSERT INTO user_identities (user_id, provider, password_hash) VALUES ($1, 'password', $2)`, [user.id, hash]);
    const session = await issueSession(c, user.id, req);
    return { user: toUser(user), ...publicSession(session) };
  });
  res.status(201).json(out);
});

authRouter.post('/login', async (req, res) => {
  const b = loginBody.parse(req.body);
  const { rows } = await pool.query<UserRow & { password_hash: string | null }>(
    `SELECT u.id, u.email, u.display_name, u.currency, u.household_id, u.household_role, i.password_hash
       FROM users u LEFT JOIN user_identities i ON i.user_id = u.id AND i.provider = 'password'
      WHERE u.email = $1`,
    [b.email],
  );
  const row = rows[0];
  const ok = await Bun.password.verify(b.password, row?.password_hash ?? (await getDummyHash()));
  if (!row || !row.password_hash || !ok) throw new HttpError(401, 'invalid_credentials', 'Correo o contraseña incorrectos');
  const session = await tx((c) => issueSession(c, row.id, req));
  res.json({ user: toUser(row), ...publicSession(session) });
});

authRouter.post('/google', async (req, res) => {
  const { idToken } = googleBody.parse(req.body);
  const profile = await verifyGoogleToken(idToken);
  if (!profile.email || !profile.emailVerified) throw new HttpError(401, 'unverified_email', 'La cuenta de Google no tiene el correo verificado');
  const mail = profile.email.trim().toLowerCase();
  const out = await tx(async (c) => {
    let user: UserRow | undefined;
    const byIdentity = await c.query<UserRow>(
      `SELECT ${USER_COLUMNS.split(', ').map((x) => `u.${x}`).join(', ')}
         FROM user_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'google' AND i.provider_sub = $1`,
      [profile.sub],
    );
    user = byIdentity.rows[0];
    if (!user) {
      const byEmail = await c.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [mail]);
      user = byEmail.rows[0] ?? (await createUserWithHousehold(c, { email: mail, displayName: profile.name }));
      await c.query(`INSERT INTO user_identities (user_id, provider, provider_sub) VALUES ($1, 'google', $2)`, [user.id, profile.sub]);
    }
    const session = await issueSession(c, user.id, req);
    return { user: toUser(user), ...publicSession(session) };
  });
  res.json(out);
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body);
  const result = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, user_id, family_id, revoked_at, expires_at < now() AS expired
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [sha256(refreshToken)],
    );
    const t = rows[0];
    if (!t) return { error: 'invalid' as const };
    if (t.revoked_at) {
      // Token ya rotado o revocado que se vuelve a usar: se asume robo y se cierra toda la familia.
      await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [t.family_id]);
      return { error: 'reused' as const };
    }
    if (t.expired) return { error: 'invalid' as const };
    const next = await issueSession(c, t.user_id, req, t.family_id);
    await c.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = $2 WHERE id = $1`, [t.id, next.refreshId]);
    const u = await c.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [t.user_id]);
    return { ok: { user: toUser(u.rows[0]!), ...publicSession(next) } };
  });
  if ('error' in result) throw new HttpError(401, 'invalid_refresh_token', 'Sesión inválida o expirada');
  res.json(result.ok);
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
    [sha256(refreshToken)],
  );
  res.status(204).end();
});

authRouter.post('/forgot-password', async (req, res) => {
  const b = forgotPasswordBody.parse(req.body);
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [b.email]);
  if (rows[0]) {
    const token = randomToken();
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [rows[0].id, sha256(token), config.resetTtlMin],
    );
    await send({
      to: b.email,
      subject: 'Recupera tu contraseña de FinSelf',
      text: `Usa este enlace para elegir una nueva contraseña (vence en ${config.resetTtlMin} minutos):\n${config.appUrl}/reset-password?token=${token}`,
    });
  }
  // Misma respuesta exista o no la cuenta, para no revelar qué correos están registrados.
  res.status(204).end();
});

authRouter.post('/reset-password', async (req, res) => {
  const b = resetPasswordBody.parse(req.body);
  const hash = await Bun.password.hash(b.password);
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, user_id FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(b.token)],
    );
    const t = rows[0];
    if (!t) throw new HttpError(400, 'invalid_token', 'El enlace es inválido o venció');
    await c.query(
      `INSERT INTO user_identities (user_id, provider, password_hash) VALUES ($1, 'password', $2)
       ON CONFLICT (user_id, provider) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [t.user_id, hash],
    );
    await c.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [t.id]);
    // Cierra todas las sesiones abiertas de la cuenta.
    await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
  });
  res.status(204).end();
});

// --- /me ---
meRouter.use(authenticate);

meRouter.get('/', async (req, res) => {
  const { rows } = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.auth.userId]);
  res.json(toUser(rows[0]!));
});

meRouter.patch('/', async (req, res) => {
  const b = patchMeBody.parse(req.body);
  const { rows } = await pool.query<UserRow>(
    `UPDATE users SET display_name = CASE WHEN $2::boolean THEN $1 ELSE display_name END,
                      currency = COALESCE($3, currency)
      WHERE id = $4 RETURNING ${USER_COLUMNS}`,
    [b.displayName ?? null, b.displayName !== undefined, b.currency ?? null, req.auth.userId],
  );
  res.json(toUser(rows[0]!));
});
