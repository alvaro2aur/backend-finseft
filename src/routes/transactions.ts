import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Db } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { buildSet } from '../lib/sql.ts';
import { idParam, isoDate, monthStr, uuid } from '../lib/validate.ts';
import { authenticate } from '../middleware/auth.ts';
import { createTransactionBody, patchTransactionBody, txnType } from '../schemas.ts';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate);

// Movimientos privados: RLS limita todo a las filas del usuario. Las categorías (compartidas o
// propias) y los instrumentos propios son visibles para el JOIN, incluso archivados.
export const TXN_SELECT = `
  SELECT t.id, t.occurred_on, t.type, t.amount, t.currency, t.description, t.source, t.created_at, t.updated_at,
         t.category_id, c.name AS category_name, c.user_id AS category_user_id,
         t.instrument_id, i.type AS instrument_type, i.bank AS instrument_bank, i.last4 AS instrument_last4
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    JOIN instruments i ON i.id = t.instrument_id`;

export const txnOut = (r: any) => ({
  id: r.id,
  date: r.occurred_on,
  type: r.type,
  amount: r.amount,
  currency: r.currency,
  description: r.description,
  categoryId: r.category_id,
  categoryName: r.category_name,
  categoryScope: r.category_id ? (r.category_user_id ? 'personal' : 'shared') : null,
  instrumentId: r.instrument_id,
  instrument: { id: r.instrument_id, type: r.instrument_type, bank: r.instrument_bank, last4: r.instrument_last4 },
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SORT: Record<string, string> = {
  date: 't.occurred_on',
  category: 'lower(c.name)',
  description: 'lower(t.description)',
  type: 't.type',
  instrument: 'i.type, lower(i.bank), i.last4',
  amount: 't.amount',
};

const listQuery = z.object({
  month: monthStr.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(), // incluido
  categoryId: z.union([uuid, z.literal('none')]).optional(),
  q: z.string().trim().max(100).optional(),
  type: txnType.optional(),
  instrumentId: uuid.optional(),
  minAmount: z.coerce.number().int().min(0).optional(),
  sortBy: z.enum(['date', 'category', 'description', 'type', 'instrument', 'amount']).default('date'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

async function fetchOne(c: Db, id: string) {
  const { rows } = await c.query(`${TXN_SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL`, [id]);
  if (!rows[0]) throw notFound('Movimiento');
  return txnOut(rows[0]);
}

// El front filtra y ordena con lo que entrega la API, por eso todo es server-side y paginado.
transactionsRouter.get('/', async (req, res) => {
  const f = listQuery.parse(req.query);
  const where: string[] = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);

  if (f.month) {
    const [y, m] = f.month.split('-').map(Number) as [number, number];
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    where.push(`t.occurred_on >= ${p(`${f.month}-01`)}`, `t.occurred_on < ${p(next)}`);
  }
  if (f.from) where.push(`t.occurred_on >= ${p(f.from)}`);
  if (f.to) where.push(`t.occurred_on <= ${p(f.to)}`);
  if (f.categoryId === 'none') where.push('t.category_id IS NULL');
  else if (f.categoryId) where.push(`t.category_id = ${p(f.categoryId)}`);
  if (f.q) where.push(`t.description ILIKE ${p(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`)}`);
  if (f.type) where.push(`t.type = ${p(f.type)}`);
  if (f.instrumentId) where.push(`t.instrument_id = ${p(f.instrumentId)}`);
  if (f.minAmount) where.push(`t.amount >= ${p(f.minAmount)}`);
  const whereSql = where.join(' AND ');

  const dir = f.sortDir === 'asc' ? 'ASC' : 'DESC';
  const orderBy = SORT[f.sortBy]!
    .split(', ')
    .map((e) => `${e} ${dir}${f.sortBy === 'category' ? ' NULLS LAST' : ''}`)
    .concat(['t.occurred_on DESC', 't.created_at DESC', 't.id'])
    .join(', ');

  const out = await withTenant(req.auth, async (c) => {
    const totals = await c.query(
      `SELECT count(*)::int AS total,
              COALESCE(sum(t.amount) FILTER (WHERE t.type = 'ingreso'), 0)::bigint AS income,
              COALESCE(sum(t.amount) FILTER (WHERE t.type = 'egreso'), 0)::bigint AS expense
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         JOIN instruments i ON i.id = t.instrument_id
        WHERE ${whereSql}`,
      params,
    );
    const items = await c.query(`${TXN_SELECT} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, params);
    return { totals: totals.rows[0], items: items.rows };
  });
  const { total, income, expense } = out.totals;
  res.json({
    items: out.items.map(txnOut),
    page: f.page,
    pageSize: f.pageSize,
    total,
    totals: { income, expense, balance: income - expense },
  });
});

transactionsRouter.get('/:id', async (req, res) => {
  const id = idParam(req);
  res.json(await withTenant(req.auth, (c) => fetchOne(c, id)));
});

transactionsRouter.post('/', async (req, res) => {
  const b = createTransactionBody.parse(req.body);
  const out = await withTenant(req.auth, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO transactions (household_id, user_id, occurred_on, type, amount, currency, category_id, instrument_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.auth.householdId, req.auth.userId, b.date, b.type, b.amount, b.currency ?? req.auth.currency, b.categoryId ?? null, b.instrumentId, b.description],
    );
    return fetchOne(c, rows[0].id);
  });
  res.status(201).json(out);
});

transactionsRouter.patch('/:id', async (req, res) => {
  const id = idParam(req);
  const b = patchTransactionBody.parse(req.body);
  const out = await withTenant(req.auth, async (c) => {
    const set = buildSet({
      occurred_on: b.date,
      type: b.type,
      amount: b.amount,
      description: b.description,
      instrument_id: b.instrumentId,
      category_id: b.categoryId,
      currency: b.currency,
    });
    if (set.empty) throw new HttpError(400, 'validation_error', 'Nada que actualizar');
    const r = await c.query(`UPDATE transactions SET ${set.sql} WHERE id = $${set.next} AND deleted_at IS NULL`, [...set.params, id]);
    if (!r.rowCount) throw notFound('Movimiento');
    return fetchOne(c, id);
  });
  res.json(out);
});

// Borrado lógico (deleted_at): se conserva para no re-importar el mismo external_ref.
transactionsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req);
  const n = await withTenant(req.auth, async (c) => {
    const r = await c.query(`UPDATE transactions SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return r.rowCount;
  });
  if (!n) throw notFound('Movimiento');
  res.status(204).end();
});
