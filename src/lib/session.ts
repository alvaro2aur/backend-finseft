import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config.ts';
import type { Db } from '../db.ts';
import { randomToken, sha256, signAccessToken } from './tokens.ts';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Crea un refresh token (se guarda solo su hash). `familyId` se mantiene al rotar. */
export async function issueSession(
  c: Db,
  userId: string,
  req: Request,
  familyId: string = randomUUID(),
): Promise<Session & { refreshId: string; familyId: string }> {
  const refreshToken = randomToken();
  const { rows } = await c.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
     RETURNING id`,
    [userId, familyId, sha256(refreshToken), req.get('user-agent') ?? null, req.ip ?? null, config.refreshTtlDays],
  );
  return {
    accessToken: await signAccessToken(userId),
    refreshToken,
    expiresIn: config.accessTtlSec,
    refreshId: rows[0].id,
    familyId,
  };
}

export const publicSession = ({ accessToken, refreshToken, expiresIn }: Session): Session => ({ accessToken, refreshToken, expiresIn });

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  currency: string;
  household_id: string;
  household_role: 'owner' | 'member';
}

export const toUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  currency: u.currency,
  householdId: u.household_id,
  householdRole: u.household_role,
});

export const USER_COLUMN_LIST = ['id', 'email', 'display_name', 'currency', 'household_id', 'household_role'] as const;
export const USER_COLUMNS = USER_COLUMN_LIST.join(', ');
/** Las mismas columnas con un alias de tabla, para consultas con JOIN (p. ej. `u.id, u.email, …`). */
export const userColumnsOf = (alias: string) => USER_COLUMN_LIST.map((c) => `${alias}.${c}`).join(', ');
