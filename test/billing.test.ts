import { describe, expect, test } from 'bun:test';
import { todayISO } from '../src/lib/dates.ts';
import { api, signup, uniqueEmail } from './helpers.ts';

// Tarjetas con día de corte: cada compra se imputa al período de facturación.
let A: Awaited<ReturnType<typeof signup>>;
const ids: Record<string, string> = {};

const post = async (path: string, body: unknown) => {
  const r = await api('POST', path, { token: A.token, body });
  if (r.status !== 201) throw new Error(`POST ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
const txn = (date: string, amount: number, instrumentId: string, categoryId: string | null = null) =>
  post('/transactions', { date, type: 'egreso', amount, description: `compra ${date}`, instrumentId, categoryId });
const month = async (id: string | undefined) => (await api('GET', `/transactions/${id}`, { token: A.token })).json.budgetMonth;

/** Misma regla que period_month en la base, para calcular lo esperado. */
function periodMonth(iso: string, cut: number | null): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const next = cut !== null && d > Math.min(cut, last);
  const mm = next ? (m === 12 ? 1 : m + 1) : m;
  return `${next && m === 12 ? y + 1 : y}-${String(mm).padStart(2, '0')}`;
}

describe('períodos de facturación de tarjetas de crédito', () => {
  test('el día de corte solo se acepta en tarjetas de crédito y entre 1 y 31', async () => {
    A = await signup(uniqueEmail('corte'));
    const bad = (body: object) => api('POST', '/instruments', { token: A.token, body: { bank: 'X', last4: '0000', ...body } });
    expect((await bad({ type: 'tarjeta_debito', billingCutDay: 26 })).status).toBe(400);
    expect((await bad({ type: 'cuenta_corriente', billingCutDay: 26 })).status).toBe(400);
    expect((await bad({ type: 'tarjeta_credito', billingCutDay: 0 })).status).toBe(400);
    expect((await bad({ type: 'tarjeta_credito', billingCutDay: 32 })).status).toBe(400);

    const itau = await post('/instruments', { type: 'tarjeta_credito', bank: 'Itau', last4: '4082', billingCutDay: 26 });
    expect(itau.billingCutDay).toBe(26);
    ids.itau = itau.id;
    ids.lider = (await post('/instruments', { type: 'tarjeta_credito', bank: 'Lider', last4: '2016', billingCutDay: 5 })).id;
    ids.cc = (await post('/instruments', { type: 'cuenta_corriente', bank: 'MACH', last4: '3154' })).id;
    ids.shared = (await post('/categories', { name: 'Súper', budget: 100000, scope: 'shared' })).id;
  });

  test('cada compra cae en el período de su tarjeta; sin corte, en el mes calendario', async () => {
    ids.t26 = (await txn('2026-10-26', 1000, ids.itau!, ids.shared!)).id; // el día de corte cierra octubre
    const t27 = await txn('2026-10-27', 2000, ids.itau!, ids.shared!); // desde el día siguiente, noviembre
    ids.t27 = t27.id;
    expect(t27.budgetMonth).toBe('2026-11');
    expect(t27.date).toBe('2026-10-27');
    ids.cc27 = (await txn('2026-10-27', 4000, ids.cc!)).id; // cuenta corriente: calendario
    ids.lider6 = (await txn('2026-10-06', 8000, ids.lider!)).id; // otra tarjeta, otro corte
    ids.dec = (await txn('2026-12-27', 16000, ids.itau!)).id; // cruza el año

    expect(await month(ids.t26)).toBe('2026-10');
    expect(await month(ids.cc27)).toBe('2026-10');
    expect(await month(ids.lider6)).toBe('2026-11');
    expect(await month(ids.dec)).toBe('2027-01');
  });

  test('el filtro `month` usa el período; `from`/`to`, la fecha de calendario', async () => {
    const list = async (qs: string) => (await api('GET', `/transactions?${qs}&sortBy=amount&sortDir=asc`, { token: A.token })).json;
    const nov = await list('month=2026-11');
    expect(nov.items.map((t: any) => t.amount)).toEqual([2000, 8000]);
    expect(nov.totals.expense).toBe(10000);
    expect((await list('month=2026-10')).items.map((t: any) => t.amount)).toEqual([1000, 4000]);
    expect((await list('from=2026-10-27&to=2026-10-27')).items.map((t: any) => t.amount)).toEqual([2000, 4000]);
  });

  test('los resúmenes personal y del grupo agrupan por período', async () => {
    const nov = (await api('GET', '/summary/personal?month=2026-11', { token: A.token })).json;
    expect(nov.totals.expense).toBe(10000);
    expect(nov.totals.vsPreviousMonth.previous).toBe(5000); // octubre: 1000 (Itau hasta el 26) + 4000 (cuenta corriente)
    const groupNov = (await api('GET', '/summary/household?month=2026-11', { token: A.token })).json;
    expect(groupNov.categories[0]).toMatchObject({ name: 'Súper', spent: 2000, mySpent: 2000 });
    const groupOct = (await api('GET', '/summary/household?month=2026-10', { token: A.token })).json;
    expect(groupOct.categories[0]).toMatchObject({ name: 'Súper', spent: 1000 });
  });

  test('editar la fecha o el instrumento de un movimiento recalcula su período', async () => {
    await api('PATCH', `/transactions/${ids.t27}`, { token: A.token, body: { date: '2026-10-20' } });
    expect(await month(ids.t27)).toBe('2026-10');
    await api('PATCH', `/transactions/${ids.t27}`, { token: A.token, body: { date: '2026-10-27' } });
    expect(await month(ids.t27)).toBe('2026-11');
    await api('PATCH', `/transactions/${ids.cc27}`, { token: A.token, body: { instrumentId: ids.itau } });
    expect(await month(ids.cc27)).toBe('2026-11');
    await api('PATCH', `/transactions/${ids.cc27}`, { token: A.token, body: { instrumentId: ids.cc } });
    expect(await month(ids.cc27)).toBe('2026-10');
  });

  test('cambiar el día de corte reimputa los movimientos de la tarjeta', async () => {
    const r = await api('PATCH', `/instruments/${ids.itau}`, { token: A.token, body: { billingCutDay: 28 } });
    expect(r.json.billingCutDay).toBe(28);
    expect(await month(ids.t27)).toBe('2026-10'); // el 27 ya no pasa el corte
    expect(await month(ids.dec)).toBe('2026-12');
    expect(await month(ids.lider6)).toBe('2026-11'); // otra tarjeta: sin cambios
  });

  test('si deja de ser tarjeta de crédito pierde el corte; una cuenta no puede tener corte', async () => {
    await api('PATCH', `/instruments/${ids.itau}`, { token: A.token, body: { billingCutDay: 26 } });
    expect(await month(ids.t27)).toBe('2026-11');
    const r = await api('PATCH', `/instruments/${ids.itau}`, { token: A.token, body: { type: 'tarjeta_debito' } });
    expect(r.json.billingCutDay).toBeNull();
    expect(await month(ids.t27)).toBe('2026-10');
    expect((await api('PATCH', `/instruments/${ids.cc}`, { token: A.token, body: { billingCutDay: 10 } })).status).toBe(400);
    expect((await api('PATCH', `/instruments/${ids.itau}`, { token: A.token, body: { type: 'cuenta_corriente', billingCutDay: 3 } })).status).toBe(400);
  });

  test('el período en curso considera el corte de cada tarjeta activa', async () => {
    const today = todayISO();
    const calendar = today.slice(0, 7);
    // Sin tarjetas con corte: el mes calendario
    const fresh = await signup(uniqueEmail('sincorte'));
    expect((await api('GET', '/periods/current', { token: fresh.token })).json).toEqual({ month: calendar });
    // Con tarjetas: el mayor entre el calendario y el período de hoy de cada una (Itau quedó sin corte; Lider corta el 5)
    const expected = [calendar, periodMonth(today, 5)].sort().at(-1);
    expect((await api('GET', '/periods/current', { token: A.token })).json).toEqual({ month: expected });
    // Un corte que ya pasó este mes empuja el período al siguiente
    const day = Number(today.slice(8, 10));
    if (day > 1) {
      await api('PATCH', `/instruments/${ids.lider}`, { token: A.token, body: { billingCutDay: day - 1 } });
      expect((await api('GET', '/periods/current', { token: A.token })).json.month).toBe(periodMonth(today, day - 1));
      expect(periodMonth(today, day - 1)).not.toBe(calendar);
    }
  });
});
