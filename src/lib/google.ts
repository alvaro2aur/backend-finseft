import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleProfile>;

const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const verifyWithGoogle: GoogleVerifier = async (idToken) => {
  if (!config.googleClientId) throw new HttpError(501, 'google_not_configured', 'Inicio de sesión con Google no está configurado');
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.googleClientId,
    });
    return {
      sub: String(payload.sub),
      email: String(payload.email ?? ''),
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch {
    throw new HttpError(401, 'invalid_google_token', 'Token de Google inválido');
  }
};

let verifier: GoogleVerifier = verifyWithGoogle;
export const verifyGoogleToken: GoogleVerifier = (t) => verifier(t);
/** Para pruebas. */
export const setGoogleVerifier = (v: GoogleVerifier | null) => {
  verifier = v ?? verifyWithGoogle;
};
