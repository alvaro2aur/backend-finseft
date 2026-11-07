import { randomToken, sha256 } from './tokens.ts';

/** Prefijo reconocible de los tokens de dispositivo (los JWT de sesión nunca empiezan así). */
export const DEVICE_TOKEN_PREFIX = 'fsd_';

/** Token nuevo: se muestra una sola vez; en la base se guarda solo `hash` y `prefix`. */
export function newDeviceToken(): { token: string; hash: string; prefix: string } {
  const token = DEVICE_TOKEN_PREFIX + randomToken();
  return { token, hash: sha256(token), prefix: token.slice(0, 12) };
}
