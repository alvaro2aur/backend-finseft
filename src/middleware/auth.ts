import type { RequestHandler } from 'express';
import { HttpError } from '../errors.ts';
import { pool, type TenantCtx } from '../db.ts';
import { verifyAccessToken } from '../lib/tokens.ts';
import { USER_COLUMNS, type UserRow } from '../lib/session.ts';

export interface AuthCtx extends TenantCtx {
  email: string;
  displayName: string | null;
  currency: string;
  role: 'owner' | 'member';
}

declare global {
  namespace Express {
    interface Request {
      auth: AuthCtx;
    }
  }
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'unauthorized', 'Falta el token de acceso');
  let userId: string;
  try {
    userId = await verifyAccessToken(header.slice(7));
  } catch {
    throw new HttpError(401, 'invalid_token', 'Token inválido o expirado');
  }
  const { rows } = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  const u = rows[0];
  if (!u) throw new HttpError(401, 'invalid_token', 'Usuario no encontrado');
  req.auth = { userId: u.id, householdId: u.household_id, email: u.email, displayName: u.display_name, currency: u.currency, role: u.household_role };
  next();
};

export const requireOwner = (req: { auth: AuthCtx }) => {
  if (req.auth.role !== 'owner') throw new HttpError(403, 'forbidden', 'Solo el owner del grupo puede hacer esto');
};
