import { describe, expect, test } from 'bun:test';
import { api, lastMailToken, signup, uniqueEmail } from './helpers.ts';

// Cada prueba arma su propio usuario: tarjeta de crédito ····4082 con corte 26, una categoría y un token de dispositivo.
async function setupUser(prefix = 'imp') {
  const email = uniqueEmail(prefix);
  const user = await signup(email);
  const post = async (path: string, body: unknown) => {
    const r = await api('POST', path, { token: user.token, body });
    if (r.status !== 201) throw new Error(`POST ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const card = await post('/instruments', { type: 'tarjeta_credito', bank: 'Itau', last4: '4082', billingCutDay: 26 });
  const category = await post('/categories', { name: 'Salud' });
  const device = (await post('/devices', { name: 'Pixel' })).token as string;
  return { email, user, post, card, category, device };
}

let seq = 0;
const item = (categoryId: string, o: Record<string, unknown> = {}) => ({
  externalId: `ext-${Date.now()}-${seq++}`,
  purchasedAt: '2026-11-03T15:00:00-03:00',
  amountMinor: 12490,
  currency: 'CLP',
  merchant: 'FARMACIA',
  cardLast4: '4082',
  categoryId,
  ...o,
});
const importItems = (token: string, items: unknown[]) => api('POST', '/imports/transactions', { token, body: { items } });

describe('POST /imports/transactions', () => {
  test('lote mixto: cada compra con su estado y el resumen cuadra', async () => {
    const u = await setupUser();
    const archived = await u.post('/categories', { name: 'Vieja' });
    await api('DELETE', `/categories/${archived.id}`, { token: u.user.token });

    const r = await importItems(u.device, [
      item(u.category.id),
      item(u.category.id, { cardLast4: '9999' }),
      item('x'),
      item(archived.id),
    ]);
    expect(r.status).toBe(200);
    const [ok, unknown, invalid, badCat] = r.json.results;
    expect(ok).toMatchObject({ index: 0, status: 'created', budgetMonth: '2026-11' });
    expect(ok.transactionId).toBeString();
    expect(unknown).toMatchObject({ index: 1, status: 'rejected', error: { code: 'unknown_card' } });
    expect(unknown.error.message).toContain('····9999');
    expect(invalid).toMatchObject({ index: 2, status: 'rejected', error: { code: 'invalid_item' } });
    expect(invalid.error.details.length).toBeGreaterThan(0);
    expect(badCat).toMatchObject({ index: 3, status: 'rejected', error: { code: 'invalid_category' } });
    expect(r.json.summary).toEqual({ created: 1, exists: 0, discarded: 0, rejected: 3, possible_duplicate: 0 });

    const t = (await api('GET', `/transactions/${ok.transactionId}`, { token: u.user.token })).json;
    expect(t).toMatchObject({ date: '2026-11-03', type: 'egreso', amount: 12490, description: 'FARMACIA', instrumentId: u.card.id, categoryId: u.category.id, source: 'app-android' });
  });

  test('reenviar el mismo lote no duplica', async () => {
    const u = await setupUser();
    const items = [item(u.category.id, { merchant: 'UNICO REENVIO' })];
    const first = (await importItems(u.device, items)).json.results[0];
    const second = (await importItems(u.device, items)).json.results[0];
    expect(first.status).toBe('created');
    expect(second).toMatchObject({ status: 'exists', transactionId: first.transactionId, budgetMonth: '2026-11' });
    expect((await api('GET', '/transactions?q=UNICO%20REENVIO', { token: u.user.token })).json.total).toBe(1);
  });

  test('el mismo externalId dos veces en un lote se registra una vez', async () => {
    const u = await setupUser();
    const it = item(u.category.id);
    const r = (await importItems(u.device, [it, it])).json;
    expect(r.results.map((x: any) => x.status)).toEqual(['created', 'exists']);
    expect(r.results[1].transactionId).toBe(r.results[0].transactionId);
  });

  test('una compra borrada en FinSelf vuelve como discarded y no se recrea', async () => {
    const u = await setupUser();
    const it = item(u.category.id, { merchant: 'BORRADA' });
    const created = (await importItems(u.device, [it])).json.results[0];
    expect((await api('DELETE', `/transactions/${created.transactionId}`, { token: u.user.token })).status).toBe(204);
    const again = (await importItems(u.device, [it])).json.results[0];
    expect(again).toMatchObject({ status: 'discarded', transactionId: created.transactionId });
    expect((await api('GET', '/transactions?q=BORRADA', { token: u.user.token })).json.total).toBe(0);
  });

  test('una tarjeta archivada no se usa', async () => {
    const u = await setupUser();
    await api('DELETE', `/instruments/${u.card.id}`, { token: u.user.token });
    const r = (await importItems(u.device, [item(u.category.id)])).json.results[0];
    expect(r).toMatchObject({ status: 'rejected', error: { code: 'unknown_card' } });
  });

  test('últimos 4 dígitos repetidos: ambigua entre dos de crédito; se prefiere la de crédito ante una de débito', async () => {
    const u = await setupUser();
    await u.post('/instruments', { type: 'tarjeta_credito', bank: 'A', last4: '5555' });
    await u.post('/instruments', { type: 'tarjeta_credito', bank: 'B', last4: '5555' });
    const credit = await u.post('/instruments', { type: 'tarjeta_credito', bank: 'C', last4: '6666' });
    await u.post('/instruments', { type: 'tarjeta_debito', bank: 'D', last4: '6666' });
    const [amb, pref] = (await importItems(u.device, [item(u.category.id, { cardLast4: '5555' }), item(u.category.id, { cardLast4: '6666' })])).json.results;
    expect(amb).toMatchObject({ status: 'rejected', error: { code: 'ambiguous_card' } });
    expect(pref.status).toBe('created');
    const t = (await api('GET', `/transactions/${pref.transactionId}`, { token: u.user.token })).json;
    expect(t.instrumentId).toBe(credit.id);
  });

  test('categoría personal de otro miembro del grupo: rechazada; una compartida: aceptada', async () => {
    const a = await setupUser('owner');
    const b = await setupUser('member');
    await api('POST', '/household/invitations', { token: a.user.token, body: { email: b.email } });
    const accepted = await api('POST', '/household/invitations/accept', { token: b.user.token, body: { token: lastMailToken(b.email) } });
    expect(accepted.status).toBe(200);
    const bPersonal = (await api('POST', '/categories', { token: b.user.token, body: { name: 'Hobby de B' } })).json;
    const shared = await a.post('/categories', { name: 'Supermercado', scope: 'shared' });
    const [other, sharedOk] = (await importItems(a.device, [item(bPersonal.id), item(shared.id)])).json.results;
    expect(other).toMatchObject({ status: 'rejected', error: { code: 'invalid_category' } });
    expect(sharedOk.status).toBe('created');
  });

  test('el período respeta el día de corte de la tarjeta', async () => {
    const u = await setupUser();
    const [before, after] = (
      await importItems(u.device, [item(u.category.id, { purchasedAt: '2026-10-26T12:00:00-03:00' }), item(u.category.id, { purchasedAt: '2026-10-27T12:00:00-03:00' })])
    ).json.results;
    expect(before.budgetMonth).toBe('2026-10');
    expect(after.budgetMonth).toBe('2026-11');
  });

  test('una compra cerca de medianoche queda con la fecha de Chile', async () => {
    const u = await setupUser();
    const r = (await importItems(u.device, [item(u.category.id, { purchasedAt: '2026-11-03T02:30:00Z' })])).json.results[0];
    const t = (await api('GET', `/transactions/${r.transactionId}`, { token: u.user.token })).json;
    expect(t.date).toBe('2026-11-02');
  });

  test('una compra en otra moneda queda en pesos con la nota', async () => {
    const u = await setupUser();
    const r = (await importItems(u.device, [item(u.category.id, { currency: 'USD', amountMinor: 1234, merchant: 'AMAZON' })])).json.results[0];
    const t = (await api('GET', `/transactions/${r.transactionId}`, { token: u.user.token })).json;
    expect(t).toMatchObject({ amount: 12, currency: 'CLP', description: 'AMAZON · USD 12,34 (monto original, ajustar a pesos)' });
  });

  test('un lote vacío, demasiado grande o que no es lista es un error de todo el lote', async () => {
    const u = await setupUser();
    expect((await importItems(u.device, [])).status).toBe(400);
    expect((await importItems(u.device, Array.from({ length: 201 }, () => item(u.category.id)))).status).toBe(400);
    expect((await api('POST', '/imports/transactions', { token: u.device, body: { items: 'x' } })).status).toBe(400);
  });
});

describe('posibles duplicados de compras digitadas a mano', () => {
  // Movimiento manual de $12.490 el 2026-11-03 con la tarjeta ····4082 (categoría Salud).
  async function withManual() {
    const u = await setupUser('dup');
    const manual = await u.post('/transactions', { date: '2026-11-03', type: 'egreso', amount: 12490, description: 'Farmacia', instrumentId: u.card.id, categoryId: u.category.id });
    return { ...u, manual };
  }
  const on = (day: string, o: Record<string, unknown> = {}) => ({ purchasedAt: `2026-11-${day}T15:00:00-03:00`, ...o });
  const count = async (token: string) => (await api('GET', '/transactions?pageSize=100', { token })).json.total as number;

  test('misma tarjeta y monto a ±1 día: posible duplicado con el movimiento parecido, sin crear nada', async () => {
    const u = await withManual();
    const before = await count(u.user.token);
    const results = (await importItems(u.device, ['02', '03', '04'].map((d) => item(u.category.id, on(d))))).json.results;
    expect(results.map((r: any) => r.status)).toEqual(['possible_duplicate', 'possible_duplicate', 'possible_duplicate']);
    expect(results[0].matches).toEqual([{ transactionId: u.manual.id, date: '2026-11-03', amount: 12490, description: 'Farmacia', categoryName: 'Salud' }]);
    expect(results[0].transactionId).toBeUndefined();
    expect(await count(u.user.token)).toBe(before);
  });

  test('fuera de rango, otro monto u otra tarjeta: se crea', async () => {
    const u = await withManual();
    await u.post('/instruments', { type: 'tarjeta_credito', bank: 'Otro', last4: '1111' });
    const results = (
      await importItems(u.device, [item(u.category.id, on('05')), item(u.category.id, on('03', { amountMinor: 12491 })), item(u.category.id, on('03', { cardLast4: '1111' }))])
    ).json.results;
    expect(results.map((r: any) => r.status)).toEqual(['created', 'created', 'created']);
  });

  test('confirmDuplicate lo registra igual', async () => {
    const u = await withManual();
    const r = (await importItems(u.device, [item(u.category.id, on('03', { confirmDuplicate: true }))])).json.results[0];
    expect(r.status).toBe('created');
  });

  test('un manual borrado no cuenta', async () => {
    const u = await withManual();
    await api('DELETE', `/transactions/${u.manual.id}`, { token: u.user.token });
    expect((await importItems(u.device, [item(u.category.id, on('03'))])).json.results[0].status).toBe('created');
  });

  test('otro importado parecido no cuenta (esos los controla externalId)', async () => {
    const u = await setupUser('dupimp');
    const first = (await importItems(u.device, [item(u.category.id, on('10'))])).json.results[0];
    const second = (await importItems(u.device, [item(u.category.id, on('10'))])).json.results[0];
    expect([first.status, second.status]).toEqual(['created', 'created']);
  });

  test('el resumen cuenta los posibles duplicados', async () => {
    const u = await withManual();
    const r = (await importItems(u.device, [item(u.category.id, on('03')), item(u.category.id, on('20'))])).json;
    expect(r.summary).toMatchObject({ possible_duplicate: 1, created: 1 });
  });
});

describe('POST /imports/suggestions', () => {
  const suggest = (token: string, merchants: unknown) => api('POST', '/imports/suggestions', { token, body: { merchants } });
  const manual = (u: Awaited<ReturnType<typeof setupUser>>, description: string, categoryId: string, date = '2026-10-10') =>
    u.post('/transactions', { date, type: 'egreso', amount: 1000, description, instrumentId: u.card.id, categoryId });

  test('sugiere la categoría más usada para el comercio; sin historial, null', async () => {
    const u = await setupUser('sug');
    const merc = await u.post('/categories', { name: 'Mercadería' });
    const otros = await u.post('/categories', { name: 'Otros' });
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) await manual(u, 'LIDER EXPRESS', merc.id, d);
    await manual(u, 'Lider Express', otros.id, '2026-10-04');
    const r = await suggest(u.device, ['  Lider   Express', 'Desconocido']);
    expect(r.status).toBe(200);
    expect(r.json.suggestions).toEqual([
      { merchant: '  Lider   Express', categoryId: merc.id, uses: 3 },
      { merchant: 'Desconocido', categoryId: null, uses: 0 },
    ]);
  });

  test('ante empate gana la categoría usada más recientemente', async () => {
    const u = await setupUser('sugtie');
    const a = await u.post('/categories', { name: 'A' });
    const b = await u.post('/categories', { name: 'B' });
    await manual(u, 'CAFE X', a.id, '2026-10-01');
    await manual(u, 'CAFE X', b.id, '2026-10-05');
    expect((await suggest(u.device, ['cafe x'])).json.suggestions[0]).toEqual({ merchant: 'cafe x', categoryId: b.id, uses: 1 });
  });

  test('no cuentan movimientos de hace más de 12 meses, de categorías archivadas ni borrados', async () => {
    const u = await setupUser('sugold');
    const old = await u.post('/categories', { name: 'Vieja' });
    const archived = await u.post('/categories', { name: 'Archivada' });
    await manual(u, 'VIEJO', old.id, '2025-10-01');
    await manual(u, 'ARCHIVADO', archived.id);
    await api('DELETE', `/categories/${archived.id}`, { token: u.user.token });
    const del = await manual(u, 'BORRADO', u.category.id);
    await api('DELETE', `/transactions/${del.id}`, { token: u.user.token });
    const s = (await suggest(u.device, ['viejo', 'archivado', 'borrado'])).json.suggestions;
    expect(s.map((x: any) => x.categoryId)).toEqual([null, null, null]);
  });

  test('un importado en otra moneda cuenta para su comercio', async () => {
    const u = await setupUser('sugusd');
    await importItems(u.device, [item(u.category.id, { currency: 'USD', amountMinor: 1234, merchant: 'AMAZON' })]);
    expect((await suggest(u.device, ['Amazon'])).json.suggestions[0]).toEqual({ merchant: 'Amazon', categoryId: u.category.id, uses: 1 });
  });

  test('no usa los movimientos de otros miembros del grupo', async () => {
    const a = await setupUser('sugowner');
    const b = await setupUser('sugmember');
    await api('POST', '/household/invitations', { token: a.user.token, body: { email: b.email } });
    await api('POST', '/household/invitations/accept', { token: b.user.token, body: { token: lastMailToken(b.email) } });
    const shared = await a.post('/categories', { name: 'Compartida', scope: 'shared' });
    await api('POST', '/transactions', { token: b.user.token, body: { date: '2026-10-10', type: 'egreso', amount: 1000, description: 'SOLO DE B', instrumentId: b.card.id, categoryId: shared.id } });
    expect((await suggest(a.device, ['solo de b'])).json.suggestions[0].categoryId).toBeNull();
    expect((await suggest(b.device, ['solo de b'])).json.suggestions[0].categoryId).toBe(shared.id);
  });

  test('una lista vacía o de más de 200 es inválida', async () => {
    const u = await setupUser('sugval');
    expect((await suggest(u.device, [])).status).toBe(400);
    expect((await suggest(u.device, Array.from({ length: 201 }, (_, i) => `m${i}`))).status).toBe(400);
  });
});
