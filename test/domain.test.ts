import { describe, expect, test } from 'bun:test';
import { api, lastMailToken, pool, signup, uniqueEmail } from './helpers.ts';

// Escenario compartido (las pruebas de este archivo corren en orden):
//   A (owner) y B (member) forman un grupo; C está en otro grupo.
const emailA = uniqueEmail('a');
const emailB = uniqueEmail('b');
const emailC = uniqueEmail('c');
let A: Awaited<ReturnType<typeof signup>>;
let B: Awaited<ReturnType<typeof signup>>;
let C: Awaited<ReturnType<typeof signup>>;
let oldHouseholdB: string;

const ids: Record<string, string> = {};
const post = async (token: string, path: string, body: unknown) => {
  const r = await api('POST', path, { token, body });
  if (r.status !== 201) throw new Error(`POST ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

describe('grupo e invitaciones', () => {
  test('A invita a B y B acepta: queda en el grupo de A', async () => {
    A = await signup(emailA, 'Ana');
    B = await signup(emailB, 'Beto');
    C = await signup(emailC, 'Cris');
    oldHouseholdB = B.user.householdId;

    expect((await api('POST', '/household/invitations', { token: B.token, body: { email: emailC } })).status).toBe(201); // B es owner de su propio grupo
    const inv = await api('POST', '/household/invitations', { token: A.token, body: { email: emailB } });
    expect(inv.status).toBe(201);
    const token = lastMailToken(emailB);

    // Otra persona no puede usar la invitación
    expect((await api('POST', '/household/invitations/accept', { token: C.token, body: { token } })).status).toBe(403);
    const ok = await api('POST', '/household/invitations/accept', { token: B.token, body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.json.householdId).toBe(A.user.householdId);
    // Un solo uso
    expect((await api('POST', '/household/invitations/accept', { token: B.token, body: { token } })).status).toBe(400);

    const hh = await api('GET', '/household', { token: A.token });
    expect(hh.json.members.map((m: any) => m.email).sort()).toEqual([emailA, emailB].sort());
    // El grupo vacío de B se eliminó
    const gone = await pool.query(`SELECT 1 FROM households WHERE id = $1`, [oldHouseholdB]);
    expect(gone.rowCount).toBe(0);
  });

  test('solo owners invitan; invitar a quien ya es miembro da 409', async () => {
    expect((await api('POST', '/household/invitations', { token: B.token, body: { email: uniqueEmail() } })).status).toBe(403);
    expect((await api('POST', '/household/invitations', { token: A.token, body: { email: emailB } })).status).toBe(409);
  });
});

describe('categorías: personales y compartidas', () => {
  test('crear con alcance y permisos', async () => {
    ids.catFood = (await post(A.token, '/categories', { name: 'Alimentación', kind: 'variable', budget: 500000, scope: 'shared' })).id;
    ids.catRent = (await post(A.token, '/categories', { name: 'Vivienda', kind: 'fija', budget: 400000, scope: 'shared' })).id;
    ids.catOcio = (await post(A.token, '/categories', { name: 'Ocio', budget: 100000 })).id; // personal por defecto
    ids.catHobby = (await post(B.token, '/categories', { name: 'Hobby', budget: 50000 })).id;

    // Un member no crea compartidas
    const denied = await api('POST', '/categories', { token: B.token, body: { name: 'Extra', scope: 'shared' } });
    expect(denied.status).toBe(403);
    // Nombre repetido en el mismo alcance → 409 (sin distinguir mayúsculas); en otro alcance se permite
    expect((await api('POST', '/categories', { token: A.token, body: { name: 'ALIMENTACIÓN', scope: 'shared' } })).status).toBe(409);
    expect((await api('POST', '/categories', { token: A.token, body: { name: 'Alimentación', scope: 'personal' } })).status).toBe(201);
  });

  test('cada usuario ve las compartidas del grupo y solo sus personales', async () => {
    const names = async (t: string) => (await api('GET', '/categories', { token: t })).json.items.map((c: any) => `${c.name}:${c.scope}`).sort();
    expect(await names(A.token)).toEqual(['Alimentación:personal', 'Alimentación:shared', 'Ocio:personal', 'Vivienda:shared']);
    expect(await names(B.token)).toEqual(['Alimentación:shared', 'Hobby:personal', 'Vivienda:shared']);
    expect(await names(C.token)).toEqual([]);
  });

  test('editar compartidas es de owners; archivar oculta pero no borra', async () => {
    expect((await api('PATCH', `/categories/${ids.catFood}`, { token: B.token, body: { budget: 1 } })).status).toBe(403);
    expect((await api('PATCH', `/categories/${ids.catHobby}`, { token: A.token, body: { budget: 1 } })).status).toBe(404); // personal de B
    const upd = await api('PATCH', `/categories/${ids.catFood}`, { token: A.token, body: { budget: 500000, name: 'Alimentación' } });
    expect(upd.status).toBe(200);
    expect((await api('PATCH', `/categories/${ids.catFood}`, { token: A.token, body: { scope: 'personal' } })).status).toBe(400); // el alcance no se edita

    const extra = await post(A.token, '/categories', { name: 'Temporal' });
    expect((await api('DELETE', `/categories/${extra.id}`, { token: A.token })).status).toBe(204);
    const list = (t: string, q = '') => api('GET', `/categories${q}`, { token: t }).then((r) => r.json.items.map((c: any) => c.name));
    expect(await list(A.token)).not.toContain('Temporal');
    expect(await list(A.token, '?includeArchived=true')).toContain('Temporal');
  });
});

describe('instrumentos (privados)', () => {
  test('crear, validar, unicidad y privacidad', async () => {
    ids.instA = (await post(A.token, '/instruments', { type: 'cuenta_corriente', bank: 'Banco A', last4: '1111' })).id;
    ids.instA2 = (await post(A.token, '/instruments', { type: 'tarjeta_credito', bank: 'Banco B', last4: '9012' })).id;
    ids.instB = (await post(B.token, '/instruments', { type: 'tarjeta_debito', bank: 'Banco A', last4: '2222' })).id;

    expect((await api('POST', '/instruments', { token: A.token, body: { type: 'cuenta_corriente', bank: 'banco a', last4: '1111' } })).status).toBe(409);
    expect((await api('POST', '/instruments', { token: A.token, body: { type: 'cuenta_corriente', bank: 'X', last4: '12' } })).status).toBe(400);
    expect((await api('POST', '/instruments', { token: A.token, body: { type: 'efectivo', bank: 'X', last4: '1234' } })).status).toBe(400);

    const bList = (await api('GET', '/instruments', { token: B.token })).json.items;
    expect(bList.map((i: any) => i.id)).toEqual([ids.instB]);
    expect((await api('PATCH', `/instruments/${ids.instA}`, { token: B.token, body: { bank: 'Hack' } })).status).toBe(404);
    expect((await api('DELETE', `/instruments/${ids.instA}`, { token: B.token })).status).toBe(404);
  });
});

describe('movimientos', () => {
  const tx = (token: string, date: string, type: string, amount: number, description: string, instrumentId: string, categoryId: string | null) =>
    post(token, '/transactions', { date, type, amount, description, instrumentId, categoryId });

  test('crear movimientos de A y B (marzo y febrero 2026)', async () => {
    ids.t1 = (await tx(A.token, '2026-03-02', 'egreso', 100000, 'Supermercado', ids.instA!, ids.catFood!)).id;
    await tx(A.token, '2026-03-03', 'egreso', 30000, 'Cine', ids.instA!, ids.catOcio!);
    await tx(A.token, '2026-03-01', 'egreso', 200000, 'Arriendo', ids.instA!, ids.catRent!);
    await tx(A.token, '2026-03-05', 'ingreso', 1000000, 'Sueldo', ids.instA!, null);
    await tx(A.token, '2026-03-06', 'egreso', 5000, 'Tienda online', ids.instA2!, null);
    await tx(A.token, '2026-02-10', 'egreso', 80000, 'Supermercado feb', ids.instA!, ids.catFood!);
    await tx(B.token, '2026-03-04', 'egreso', 250000, 'Feria y super', ids.instB!, ids.catFood!);
    await tx(B.token, '2026-03-03', 'egreso', 20000, 'Hobby', ids.instB!, ids.catHobby!);
    await tx(B.token, '2026-02-12', 'egreso', 40000, 'Super feb', ids.instB!, ids.catFood!);
  });

  test('las referencias ajenas se rechazan', async () => {
    const base = { date: '2026-03-07', type: 'egreso', amount: 1, description: 'x' };
    // B no puede usar el instrumento de A ni la categoría personal de A
    expect((await api('POST', '/transactions', { token: B.token, body: { ...base, instrumentId: ids.instA, categoryId: null } })).status).toBe(422);
    expect((await api('POST', '/transactions', { token: B.token, body: { ...base, instrumentId: ids.instB, categoryId: ids.catOcio } })).status).toBe(422);
    // C no puede usar categorías compartidas de otro grupo
    const instC = (await post(C.token, '/instruments', { type: 'cuenta_corriente', bank: 'Banco C', last4: '3333' })).id;
    expect((await api('POST', '/transactions', { token: C.token, body: { ...base, instrumentId: instC, categoryId: ids.catFood } })).status).toBe(422);
    expect((await api('POST', '/transactions', { token: A.token, body: { ...base, amount: 0, instrumentId: ids.instA } })).status).toBe(400);
  });

  test('privacidad: cada usuario solo ve los suyos', async () => {
    const a = await api('GET', '/transactions?pageSize=100', { token: A.token });
    const b = await api('GET', '/transactions?pageSize=100', { token: B.token });
    expect(a.json.total).toBe(6);
    expect(b.json.total).toBe(3);
    expect(a.json.items.every((t: any) => !['Feria y super', 'Hobby', 'Super feb'].includes(t.description))).toBe(true);
    expect((await api('GET', `/transactions/${ids.t1}`, { token: B.token })).status).toBe(404);
    expect((await api('GET', `/transactions/${ids.t1}`, { token: C.token })).status).toBe(404);
    expect((await api('PATCH', `/transactions/${ids.t1}`, { token: B.token, body: { amount: 1 } })).status).toBe(404);
    expect((await api('DELETE', `/transactions/${ids.t1}`, { token: B.token })).status).toBe(404);
  });

  test('defensa en profundidad: sin contexto de grupo la base no entrega filas', async () => {
    expect((await pool.query(`SELECT count(*)::int AS n FROM transactions`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM categories`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM instruments`)).rows[0].n).toBe(0);
  });

  test('filtros, orden, paginación y totales', async () => {
    const get = async (qs: string) => (await api('GET', `/transactions?${qs}`, { token: A.token })).json;

    const march = await get('month=2026-03&pageSize=100');
    expect(march.total).toBe(5);
    expect(march.totals).toEqual({ income: 1000000, expense: 335000, balance: 665000 });

    expect((await get('month=2026-03&type=ingreso')).items.map((t: any) => t.description)).toEqual(['Sueldo']);
    expect((await get('month=2026-03&categoryId=none')).total).toBe(2);
    expect((await get(`month=2026-03&categoryId=${ids.catFood}`)).items.map((t: any) => t.description)).toEqual(['Supermercado']);
    expect((await get(`instrumentId=${ids.instA2}`)).total).toBe(1);
    expect((await get('q=super')).total).toBe(2);
    expect((await get('q=%25')).total).toBe(0); // % se trata como texto, no como comodín
    expect((await get('month=2026-03&minAmount=100000')).total).toBe(3);
    expect((await get('from=2026-03-03&to=2026-03-05')).total).toBe(2);

    const byAmount = await get('month=2026-03&sortBy=amount&sortDir=asc&pageSize=100');
    expect(byAmount.items.map((t: any) => t.amount)).toEqual([5000, 30000, 100000, 200000, 1000000]);
    const byCat = await get('month=2026-03&sortBy=category&sortDir=asc&pageSize=100');
    expect(byCat.items.slice(-2).every((t: any) => t.categoryId === null)).toBe(true); // sin categoría al final

    const p1 = await get('month=2026-03&sortBy=amount&sortDir=desc&pageSize=2&page=1');
    const p3 = await get('month=2026-03&sortBy=amount&sortDir=desc&pageSize=2&page=3');
    expect(p1.items.map((t: any) => t.amount)).toEqual([1000000, 200000]);
    expect(p3.items.map((t: any) => t.amount)).toEqual([5000]);
    expect(p1.total).toBe(5);

    const item = p1.items[1];
    expect(item).toMatchObject({ date: '2026-03-01', categoryName: 'Vivienda', categoryScope: 'shared' });
    expect(item.instrument).toMatchObject({ type: 'cuenta_corriente', bank: 'Banco A', last4: '1111' });

    expect((await api('GET', '/transactions?pageSize=500', { token: A.token })).status).toBe(400);
    expect((await api('GET', '/transactions?sortBy=drop', { token: A.token })).status).toBe(400);
  });

  test('editar y borrar (borrado lógico)', async () => {
    const upd = await api('PATCH', `/transactions/${ids.t1}`, { token: A.token, body: { amount: 110000, categoryId: null } });
    expect(upd.status).toBe(200);
    expect(upd.json.amount).toBe(110000);
    expect(upd.json.categoryId).toBeNull();
    expect((await api('PATCH', `/transactions/${ids.t1}`, { token: A.token, body: {} })).status).toBe(400);
    // Se deja como estaba para los resúmenes
    await api('PATCH', `/transactions/${ids.t1}`, { token: A.token, body: { amount: 100000, categoryId: ids.catFood } });

    const extra = await tx(A.token, '2026-03-08', 'egreso', 1000, 'Borrar', ids.instA!, null);
    expect((await api('DELETE', `/transactions/${extra.id}`, { token: A.token })).status).toBe(204);
    expect((await api('GET', `/transactions/${extra.id}`, { token: A.token })).status).toBe(404);
    expect((await api('DELETE', `/transactions/${extra.id}`, { token: A.token })).status).toBe(404);
  });
});

describe('resúmenes (marzo 2026, mes cerrado)', () => {
  test('personal de A', async () => {
    const r = await api('GET', '/summary/personal?month=2026-03', { token: A.token });
    expect(r.status).toBe(200);
    const s = r.json;
    expect(s).toMatchObject({ month: '2026-03', daysInMonth: 31, daysElapsed: 31 });
    // Presupuesto: solo categorías personales (Ocio y la personal "Alimentación" sin gasto)
    expect(s.categories.map((c: any) => [c.name, c.budget, c.spent])).toEqual([
      ['Ocio', 100000, 30000],
      ['Alimentación', 0, 0],
    ]);
    expect(s.categories[0]).toMatchObject({ pct: 30, over: false, left: 70000, scope: 'personal' });
    expect(s.categories[1]).toMatchObject({ pct: null, over: false, left: null }); // 0 = sin límite
    expect(s.totals).toMatchObject({ budget: 100000, spent: 30000, available: 70000, usedPct: 30, perDayAllowed: null });
    // Todo lo propio: 100000 + 30000 + 200000 + 5000
    expect(s.totals).toMatchObject({ expense: 335000, income: 1000000, savings: 665000, savingsPct: 67 });
    expect(s.totals.dailyAverage).toBe(10806);
    expect(s.totals.dailyAverageWithoutFixed).toBe(4354);
    expect(s.totals.vsPreviousMonth).toEqual({ previous: 80000, amount: 255000, pct: 318.8 });
    expect(s.sharedContribution).toEqual([
      { id: ids.catRent, name: 'Vivienda', kind: 'fija', mySpent: 200000 },
      { id: ids.catFood, name: 'Alimentación', kind: 'variable', mySpent: 100000 },
    ]);
    expect(s.uncategorized).toEqual({ mySpent: 5000 });
    expect(s.recent).toHaveLength(5);
  });

  test('personal de B no mezcla nada de A', async () => {
    const s = (await api('GET', '/summary/personal?month=2026-03', { token: B.token })).json;
    expect(s.categories.map((c: any) => [c.name, c.spent])).toEqual([['Hobby', 20000]]);
    expect(s.totals).toMatchObject({ expense: 270000, income: 0, savings: -270000, savingsPct: null });
    expect(s.sharedContribution).toEqual([{ id: ids.catFood, name: 'Alimentación', kind: 'variable', mySpent: 250000 }]);
  });

  test('del grupo suma a todos los miembros y solo entrega totales', async () => {
    const forA = (await api('GET', '/summary/household?month=2026-03', { token: A.token })).json;
    expect(forA.memberCount).toBe(2);
    expect(forA.categories.map((c: any) => [c.name, c.budget, c.spent, c.mySpent, c.scope])).toEqual([
      ['Alimentación', 500000, 350000, 100000, 'shared'],
      ['Vivienda', 400000, 200000, 200000, 'shared'],
    ]);
    expect(forA.categories[0]).toMatchObject({ pct: 70, over: false, left: 150000 });
    expect(forA.totals).toMatchObject({ budget: 900000, spent: 550000, available: 350000, usedPct: 61, mySpent: 300000, dailyAverage: 17741, dailyAverageWithoutFixed: 11290 });
    expect(forA.totals.vsPreviousMonth).toEqual({ previous: 120000, amount: 430000, pct: 358.3 });
    expect(JSON.stringify(forA)).not.toContain('Feria'); // ningún movimiento ajeno

    const forB = (await api('GET', '/summary/household?month=2026-03', { token: B.token })).json;
    expect(forB.categories[0]).toMatchObject({ name: 'Alimentación', spent: 350000, mySpent: 250000 });

    const forC = (await api('GET', '/summary/household?month=2026-03', { token: C.token })).json;
    expect(forC.categories).toEqual([]);
    expect(forC.totals.spent).toBe(0);
  });

  test('mes inválido responde 400; sin mes usa el actual', async () => {
    expect((await api('GET', '/summary/personal?month=2026-13', { token: A.token })).status).toBe(400);
    const now = (await api('GET', '/summary/personal', { token: A.token })).json;
    expect(now.month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('roles y salida del grupo', () => {
  test('el último owner no puede irse ni dejarse sin owner', async () => {
    expect((await api('POST', '/household/leave', { token: A.token })).status).toBe(409);
    expect((await api('PATCH', `/household/members/${A.user.id}`, { token: A.token, body: { role: 'member' } })).status).toBe(409);
    // Promover y volver a bajar a B funciona mientras quede un owner
    expect((await api('PATCH', `/household/members/${B.user.id}`, { token: A.token, body: { role: 'owner' } })).status).toBe(200);
    expect((await api('PATCH', `/household/members/${B.user.id}`, { token: A.token, body: { role: 'member' } })).status).toBe(200);
    expect((await api('PATCH', `/household/members/${B.user.id}`, { token: B.token, body: { role: 'owner' } })).status).toBe(403);
  });

  test('B se va: conserva sus datos privados y pierde el vínculo con lo compartido', async () => {
    const before = (await api('GET', '/transactions?pageSize=100', { token: B.token })).json.total;
    const left = await api('POST', '/household/leave', { token: B.token });
    expect(left.status).toBe(200);
    expect(left.json.role).toBe('owner');

    const hh = await api('GET', '/household', { token: B.token });
    expect(hh.json.id).toBe(left.json.householdId);
    expect(hh.json.members).toHaveLength(1);

    // Mismos movimientos e instrumentos; los de categorías compartidas quedaron sin categoría
    const txns = (await api('GET', '/transactions?pageSize=100', { token: B.token })).json;
    expect(txns.total).toBe(before);
    const byDesc = Object.fromEntries(txns.items.map((t: any) => [t.description, t]));
    expect(byDesc['Feria y super'].categoryId).toBeNull();
    expect(byDesc['Hobby'].categoryName).toBe('Hobby'); // la categoría personal lo siguió
    expect((await api('GET', '/instruments', { token: B.token })).json.items).toHaveLength(1);

    // Ya no ve lo compartido y A deja de contar su gasto en el grupo
    const names = (await api('GET', '/categories', { token: B.token })).json.items.map((c: any) => c.name);
    expect(names).toEqual(['Hobby']);
    const forA = (await api('GET', '/summary/household?month=2026-03', { token: A.token })).json;
    expect(forA.memberCount).toBe(1);
    expect(forA.categories[0]).toMatchObject({ name: 'Alimentación', spent: 100000 });

    // A queda sola: no hay de qué irse
    expect((await api('POST', '/household/leave', { token: A.token })).status).toBe(409);
  });
});
