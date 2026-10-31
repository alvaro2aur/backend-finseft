import { describe, expect, test } from 'bun:test';
import { setGoogleVerifier } from '../src/lib/google.ts';
import { api, lastMailToken, PASSWORD, signup, uniqueEmail } from './helpers.ts';

describe('registro y login', () => {
  const email = uniqueEmail('auth');

  test('registrar crea usuario y grupo propio como owner', async () => {
    const r = await api('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: 'Ana' } });
    expect(r.status).toBe(201);
    expect(r.json.user.email).toBe(email);
    expect(r.json.user.householdRole).toBe('owner');
    expect(r.json.accessToken).toBeString();
    expect(r.json.refreshToken).toBeString();
  });

  test('correo repetido (sin distinguir mayúsculas) responde 409', async () => {
    const r = await api('POST', '/auth/register', { body: { email: email.toUpperCase(), password: PASSWORD } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('email_taken');
  });

  test('contraseña corta responde 400', async () => {
    const r = await api('POST', '/auth/register', { body: { email: uniqueEmail(), password: '123' } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_error');
  });

  test('login correcto e incorrecto', async () => {
    const ok = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect((await api('POST', '/auth/login', { body: { email, password: 'otra-clave-1' } })).status).toBe(401);
    expect((await api('POST', '/auth/login', { body: { email: uniqueEmail(), password: PASSWORD } })).status).toBe(401);
  });

  test('/me exige token y devuelve el usuario', async () => {
    expect((await api('GET', '/me')).status).toBe(401);
    expect((await api('GET', '/me', { token: 'basura' })).status).toBe(401);
    const { token, user } = await signup(uniqueEmail(), 'Beto');
    const me = await api('GET', '/me', { token });
    expect(me.status).toBe(200);
    expect(me.json.id).toBe(user.id);
    expect(me.json.displayName).toBe('Beto');
  });
});

describe('refresh tokens', () => {
  test('rota el token y detecta la reutilización cerrando la familia', async () => {
    const { refresh } = await signup(uniqueEmail());
    const r1 = await api('POST', '/auth/refresh', { body: { refreshToken: refresh } });
    expect(r1.status).toBe(200);
    expect(r1.json.refreshToken).not.toBe(refresh);

    const reuse = await api('POST', '/auth/refresh', { body: { refreshToken: refresh } });
    expect(reuse.status).toBe(401);
    // El token nuevo también quedó revocado
    expect((await api('POST', '/auth/refresh', { body: { refreshToken: r1.json.refreshToken } })).status).toBe(401);
  });

  test('logout revoca la sesión', async () => {
    const { refresh } = await signup(uniqueEmail());
    expect((await api('POST', '/auth/logout', { body: { refreshToken: refresh } })).status).toBe(204);
    expect((await api('POST', '/auth/refresh', { body: { refreshToken: refresh } })).status).toBe(401);
  });
});

describe('recuperar contraseña', () => {
  test('flujo completo, token de un solo uso y sesiones cerradas', async () => {
    const email = uniqueEmail('reset');
    const { refresh } = await signup(email);

    // Misma respuesta exista o no la cuenta
    expect((await api('POST', '/auth/forgot-password', { body: { email: uniqueEmail() } })).status).toBe(204);
    expect((await api('POST', '/auth/forgot-password', { body: { email } })).status).toBe(204);
    const token = lastMailToken(email);

    expect((await api('POST', '/auth/reset-password', { body: { token: 'x'.repeat(20), password: 'nueva-clave-1' } })).status).toBe(400);
    expect((await api('POST', '/auth/reset-password', { body: { token, password: 'nueva-clave-1' } })).status).toBe(204);
    expect((await api('POST', '/auth/reset-password', { body: { token, password: 'otra-clave-22' } })).status).toBe(400);

    expect((await api('POST', '/auth/login', { body: { email, password: PASSWORD } })).status).toBe(401);
    expect((await api('POST', '/auth/login', { body: { email, password: 'nueva-clave-1' } })).status).toBe(200);
    expect((await api('POST', '/auth/refresh', { body: { refreshToken: refresh } })).status).toBe(401);
  });
});

describe('google', () => {
  test('crea la cuenta, reutiliza la identidad y vincula por correo', async () => {
    const email = uniqueEmail('g');
    setGoogleVerifier(async () => ({ sub: `sub-${email}`, email, emailVerified: true, name: 'Gina' }));
    const first = await api('POST', '/auth/google', { body: { idToken: 'token-de-prueba' } });
    expect(first.status).toBe(200);
    expect(first.json.user.displayName).toBe('Gina');
    const second = await api('POST', '/auth/google', { body: { idToken: 'token-de-prueba' } });
    expect(second.json.user.id).toBe(first.json.user.id);

    // Cuenta con contraseña existente + Google con el mismo correo verificado: se vincula
    const pwEmail = uniqueEmail('gl');
    const existing = await signup(pwEmail);
    setGoogleVerifier(async () => ({ sub: `sub-${pwEmail}`, email: pwEmail, emailVerified: true }));
    const linked = await api('POST', '/auth/google', { body: { idToken: 'token-de-prueba' } });
    expect(linked.json.user.id).toBe(existing.user.id);

    // Correo no verificado: rechazado
    setGoogleVerifier(async () => ({ sub: 'sub-x', email: uniqueEmail(), emailVerified: false }));
    expect((await api('POST', '/auth/google', { body: { idToken: 'token-de-prueba' } })).status).toBe(401);
    setGoogleVerifier(null);
  });

  test('sin GOOGLE_CLIENT_ID responde 501', async () => {
    setGoogleVerifier(null);
    expect((await api('POST', '/auth/google', { body: { idToken: 'token-de-prueba' } })).status).toBe(501);
  });
});
