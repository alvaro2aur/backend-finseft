import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, tx, withTenant, type Db } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { send } from '../lib/mailer.ts';
import { randomToken, sha256 } from '../lib/tokens.ts';
import { idParam } from '../lib/validate.ts';
import { authenticate, requireOwner, type AuthCtx } from '../middleware/auth.ts';
import { acceptInvitationBody, inviteBody, patchHouseholdBody, patchMemberBody } from '../schemas.ts';

export const householdRouter = Router();
householdRouter.use(authenticate);

const memberOut = (m: any) => ({ id: m.id, email: m.email, displayName: m.display_name, role: m.household_role });

householdRouter.get('/', async (req, res) => {
  const hh = await pool.query(`SELECT id, name FROM households WHERE id = $1`, [req.auth.householdId]);
  const members = await pool.query(
    `SELECT id, email, display_name, household_role FROM users WHERE household_id = $1 ORDER BY created_at, id`,
    [req.auth.householdId],
  );
  res.json({ id: hh.rows[0].id, name: hh.rows[0].name, myRole: req.auth.role, members: members.rows.map(memberOut) });
});

householdRouter.patch('/', async (req, res) => {
  requireOwner(req);
  const b = patchHouseholdBody.parse(req.body);
  const { rows } = await pool.query(`UPDATE households SET name = $1 WHERE id = $2 RETURNING id, name`, [b.name, req.auth.householdId]);
  res.json(rows[0]);
});

householdRouter.patch('/members/:id', async (req, res) => {
  requireOwner(req);
  const id = idParam(req);
  const b = patchMemberBody.parse(req.body);
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE users SET household_role = $1 WHERE id = $2 AND household_id = $3
       RETURNING id, email, display_name, household_role`,
      [b.role, id, req.auth.householdId],
    );
    if (!rows[0]) throw notFound('Miembro');
    const owners = await c.query(`SELECT 1 FROM users WHERE household_id = $1 AND household_role = 'owner' LIMIT 1`, [req.auth.householdId]);
    if (!owners.rowCount) throw new HttpError(409, 'last_owner', 'El grupo debe tener al menos un owner');
    return memberOut(rows[0]);
  });
  res.json(out);
});

// --- Invitaciones ---

const invitationOut = (i: any) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, createdAt: i.created_at });

householdRouter.get('/invitations', async (req, res) => {
  requireOwner(req);
  const { rows } = await pool.query(
    `SELECT id, email, role, expires_at, created_at FROM household_invitations
      WHERE household_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [req.auth.householdId],
  );
  res.json({ items: rows.map(invitationOut) });
});

householdRouter.post('/invitations', async (req, res) => {
  requireOwner(req);
  const b = inviteBody.parse(req.body);
  const member = await pool.query(`SELECT 1 FROM users WHERE household_id = $1 AND email = $2`, [req.auth.householdId, b.email]);
  if (member.rowCount) throw new HttpError(409, 'already_member', 'Esa persona ya es parte del grupo');
  const token = randomToken();
  const { rows } = await pool.query(
    `INSERT INTO household_invitations (household_id, invited_by, email, role, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
     RETURNING id, email, role, expires_at, created_at`,
    [req.auth.householdId, req.auth.userId, b.email, b.role, sha256(token), config.inviteTtlDays],
  );
  await send({
    to: b.email,
    subject: `${req.auth.displayName ?? req.auth.email} te invitó a su grupo en FinSelf`,
    text: `Acepta la invitación (vence en ${config.inviteTtlDays} días):\n${config.appUrl}/invitations/accept?token=${token}`,
  });
  res.status(201).json(invitationOut(rows[0]));
});

householdRouter.delete('/invitations/:id', async (req, res) => {
  requireOwner(req);
  const r = await pool.query(`DELETE FROM household_invitations WHERE id = $1 AND household_id = $2 AND accepted_at IS NULL`, [
    idParam(req),
    req.auth.householdId,
  ]);
  if (!r.rowCount) throw notFound('Invitación');
  res.status(204).end();
});

/**
 * Pasa al usuario a otro grupo. Debe ejecutarse dentro de withTenant del grupo actual.
 * Sus instrumentos, movimientos y categorías personales lo siguen (ON UPDATE CASCADE);
 * lo que apunta a categorías compartidas del grupo anterior se deja sin categoría.
 */
async function moveUser(c: Db, auth: AuthCtx, targetHouseholdId: string, role: 'owner' | 'member') {
  if (auth.role === 'owner') {
    const { rows } = await c.query(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE household_role = 'owner'))::int AS owners
         FROM users WHERE household_id = $1 AND id <> $2`,
      [auth.householdId, auth.userId],
    );
    if (rows[0].total > 0 && rows[0].owners === 0) {
      throw new HttpError(409, 'last_owner', 'Eres el único owner del grupo; promueve a otro miembro antes de irte');
    }
  }
  await c.query(`DELETE FROM household_invitations WHERE invited_by = $1`, [auth.userId]);
  await c.query(
    `UPDATE transactions SET category_id = NULL
      WHERE user_id = $1 AND category_id IN (SELECT id FROM categories WHERE user_id IS NULL)`,
    [auth.userId],
  );
  await c.query(`UPDATE users SET household_id = $1, household_role = $2 WHERE id = $3`, [targetHouseholdId, role, auth.userId]);
  // Si el grupo anterior quedó vacío se elimina (con sus categorías compartidas).
  await c.query(`DELETE FROM households h WHERE h.id = $1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.household_id = h.id)`, [
    auth.householdId,
  ]);
}

householdRouter.post('/invitations/accept', async (req, res) => {
  const { token } = acceptInvitationBody.parse(req.body);
  const out = await withTenant(req.auth, async (c) => {
    const { rows } = await c.query(
      `SELECT id, household_id, email, role, accepted_at, expires_at < now() AS expired
         FROM household_invitations WHERE token_hash = $1 FOR UPDATE`,
      [sha256(token)],
    );
    const inv = rows[0];
    if (!inv || inv.accepted_at || inv.expired) throw new HttpError(400, 'invalid_token', 'La invitación es inválida o venció');
    if (String(inv.email).toLowerCase() !== req.auth.email.toLowerCase()) {
      throw new HttpError(403, 'wrong_account', 'La invitación es para otro correo');
    }
    if (inv.household_id === req.auth.householdId) throw new HttpError(409, 'already_member', 'Ya eres parte de este grupo');
    await moveUser(c, req.auth, inv.household_id, inv.role);
    await c.query(`UPDATE household_invitations SET accepted_at = now() WHERE id = $1`, [inv.id]);
    return { householdId: inv.household_id, role: inv.role };
  });
  res.json(out);
});

householdRouter.post('/leave', async (req, res) => {
  const out = await withTenant(req.auth, async (c) => {
    const others = await c.query(`SELECT 1 FROM users WHERE household_id = $1 AND id <> $2 LIMIT 1`, [req.auth.householdId, req.auth.userId]);
    if (!others.rowCount) throw new HttpError(409, 'alone_in_household', 'Eres la única persona del grupo');
    const hh = await c.query(`INSERT INTO households (name) VALUES ($1) RETURNING id`, [
      `Hogar de ${req.auth.displayName ?? req.auth.email.split('@')[0]}`,
    ]);
    await moveUser(c, req.auth, hh.rows[0].id, 'owner');
    return { householdId: hh.rows[0].id, role: 'owner' as const };
  });
  res.json(out);
});
