import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { outbox } from '../src/lib/mailer.ts';
import { checkContract } from './contract.ts';

export { outbox };
export { pool } from '../src/db.ts';

const server = createApp().listen(0);
server.unref();
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

export async function api(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  // Toda respuesta debe cumplir el OpenAPI: así las pruebas de dominio también verifican el contrato.
  const problem = checkContract(method, path, res.status, json);
  if (problem) throw new Error(`Contrato incumplido — ${problem}\nCuerpo: ${text.slice(0, 400)}`);
  return { status: res.status, json };
}

export const PASSWORD = 'password123';

export async function signup(email: string, displayName?: string) {
  const r = await api('POST', '/auth/register', { body: { email, password: PASSWORD, displayName } });
  if (r.status !== 201) throw new Error(`signup falló: ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.accessToken as string, refresh: r.json.refreshToken as string, user: r.json.user };
}

/** Último token enviado por correo a `to` (enlaces con ?token=...). */
export function lastMailToken(to: string): string {
  const mail = outbox.filter((m) => m.to === to).at(-1);
  const m = mail && /token=([\w-]+)/.exec(mail.text);
  if (!m) throw new Error(`no hay correo con token para ${to}`);
  return m[1]!;
}

let n = 0;
export const uniqueEmail = (p = 'user') => `${p}${Date.now()}${n++}@test.cl`;
