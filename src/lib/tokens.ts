import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.ts';

const key = new TextEncoder().encode(config.jwtSecret);

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** El access token solo lleva el id del usuario; el grupo y el rol se leen de la base en cada request. */
export function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtlSec}s`)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
  if (!payload.sub) throw new Error('token sin sub');
  return payload.sub;
}
