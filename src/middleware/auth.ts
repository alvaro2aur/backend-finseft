import type { Request, RequestHandler } from 'express';
import { HttpError } from '../errors.ts';
import { pool, type TenantCtx } from '../db.ts';
import { DEVICE_TOKEN_PREFIX } from '../lib/deviceTokens.ts';
import { sha256, verifyAccessToken } from '../lib/tokens.ts';
import { USER_COLUMNS, type UserRow } from '../lib/session.ts';

export interface AuthCtx extends TenantCtx {
  email: string;
  displayName: string | null;
  currency: string;
  role: 'owner' | 'member';
  kind: 'user' | 'device'; // sesión de la web (JWT) o token de dispositivo (app)
  deviceId?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth: AuthCtx;
    }
  }
}

/** Únicas operaciones permitidas con un token de dispositivo. Todo lo demás responde 403. */
export const DEVICE_ROUTES: ReadonlySet<string> = new Set([
  'GET /categories',
  'GET /instruments',
  'POST /imports/transactions',
  'POST /imports/suggestions',
]);

/** "MÉTODO /ruta" de la request, sin barra final (p. ej. "GET /categories"). */
export const routeKey = (req: Request): string => `${req.method} ${req.baseUrl}${req.path === '/' ? '' : req.path}`;

const toCtx = (u: UserRow, kind: AuthCtx['kind'], deviceId?: string): AuthCtx => ({
  userId: u.id,
  householdId: u.household_id,
  email: u.email,
  displayName: u.display_name,
  currency: u.currency,
  role: u.household_role,
  kind,
  ...(deviceId ? { deviceId } : {}),
});

async function deviceAuth(req: Request, token: string): Promise<AuthCtx> {
  const { rows } = await pool.query<UserRow & { device_id: string; fresh: boolean }>(
    `SELECT d.id AS device_id, COALESCE(d.last_used_at > now() - interval '60 seconds', false) AS fresh,
            ${USER_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')}
       FROM device_tokens d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, 'invalid_token', 'Token de dispositivo inválido o revocado');
  if (!DEVICE_ROUTES.has(routeKey(req))) throw new HttpError(403, 'forbidden', 'Un token de dispositivo no tiene acceso a esta operación');
  // Basta con registrar el uso una vez por minuto.
  if (!row.fresh) await pool.query(`UPDATE device_tokens SET last_used_at = now() WHERE id = $1`, [row.device_id]);
  return toCtx(row, 'device', row.device_id);
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'unauthorized', 'Falta el token de acceso');
  const token = header.slice(7);
  if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
    req.auth = await deviceAuth(req, token);
    return next();
  }
  let userId: string;
  try {
    userId = await verifyAccessToken(token);
  } catch {
    throw new HttpError(401, 'invalid_token', 'Token inválido o expirado');
  }
  const { rows } = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  const u = rows[0];
  if (!u) throw new HttpError(401, 'invalid_token', 'Usuario no encontrado');
  req.auth = toCtx(u, 'user');
  next();
};

export const requireOwner = (req: { auth: AuthCtx }) => {
  if (req.auth.role !== 'owner') throw new HttpError(403, 'forbidden', 'Solo el owner del grupo puede hacer esto');
};
