import { describe, expect, test } from 'bun:test';
import { api, signup, uniqueEmail } from './helpers.ts';

const newDevice = async (userToken: string, name = 'Pixel de prueba') => {
  const r = await api('POST', '/devices', { token: userToken, body: { name } });
  if (r.status !== 201) throw new Error(`POST /devices → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

describe('tokens de dispositivo', () => {
  test('crear, listar y usar un token', async () => {
    const A = await signup(uniqueEmail('dev'));
    const created = await newDevice(A.token);
    expect(created.token).toStartWith('fsd_');
    expect(created.token.startsWith(created.prefix)).toBe(true);
    expect(created).toMatchObject({ name: 'Pixel de prueba', revoked: false, lastUsedAt: null });

    const list = (await api('GET', '/devices', { token: A.token })).json.items;
    expect(list).toHaveLength(1);
    expect(list[0].token).toBeUndefined(); // el token solo se muestra al crearlo
    expect(list[0].prefix).toBe(created.prefix);

    expect((await api('GET', '/categories', { token: created.token })).status).toBe(200);
    expect((await api('GET', '/instruments', { token: created.token })).status).toBe(200);
    const after = (await api('GET', '/devices', { token: A.token })).json.items[0];
    expect(after.lastUsedAt).not.toBeNull();
  });

  test('el token de dispositivo no sirve fuera de su lista', async () => {
    const A = await signup(uniqueEmail('devscope'));
    const cat = (await api('POST', '/categories', { token: A.token, body: { name: 'Ocio' } })).json;
    const dev = (await newDevice(A.token)).token;
    for (const [method, path] of [
      ['GET', '/transactions'],
      ['DELETE', `/categories/${cat.id}`],
      ['GET', '/devices'],
      ['GET', '/me'],
      ['GET', '/summary/personal'],
    ] as const) {
      const r = await api(method, path, { token: dev });
      expect(`${method} ${path} → ${r.status} ${r.json?.error?.code}`).toBe(`${method} ${path} → 403 forbidden`);
    }
    // El DELETE rechazado no archivó nada
    const cats = (await api('GET', '/categories', { token: A.token })).json.items;
    expect(cats.map((c: any) => c.name)).toEqual(['Ocio']);
  });

  test('revocar corta el acceso de inmediato', async () => {
    const A = await signup(uniqueEmail('devrevoke'));
    const d = await newDevice(A.token);
    expect((await api('GET', '/categories', { token: d.token })).status).toBe(200);
    expect((await api('DELETE', `/devices/${d.id}`, { token: A.token })).status).toBe(204);
    const r = await api('GET', '/categories', { token: d.token });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('invalid_token');
    const list = (await api('GET', '/devices', { token: A.token })).json.items;
    expect(list[0].revoked).toBe(true);
  });

  test('tokens inventados o de otro usuario', async () => {
    const A = await signup(uniqueEmail('devA'));
    const B = await signup(uniqueEmail('devB'));
    const d = await newDevice(A.token);
    expect((await api('GET', '/categories', { token: 'fsd_inventado1234567890' })).status).toBe(401);
    expect((await api('DELETE', `/devices/${d.id}`, { token: B.token })).status).toBe(404);
    expect((await api('GET', '/devices', { token: B.token })).json.items).toEqual([]);
    expect((await api('GET', '/categories', { token: d.token })).status).toBe(200); // sigue vigente
  });

  test('un token de dispositivo no crea ni revoca dispositivos', async () => {
    const A = await signup(uniqueEmail('devself'));
    const d = await newDevice(A.token);
    expect((await api('POST', '/devices', { token: d.token, body: { name: 'otro' } })).status).toBe(403);
    expect((await api('DELETE', `/devices/${d.id}`, { token: d.token })).status).toBe(403);
  });

  test('el nombre es obligatorio', async () => {
    const A = await signup(uniqueEmail('devname'));
    const r = await api('POST', '/devices', { token: A.token, body: { name: '   ' } });
    expect(r.status).toBe(400);
  });
});
