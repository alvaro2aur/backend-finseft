import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { buildSet } from '../lib/sql.ts';
import { boolParam, idParam } from '../lib/validate.ts';
import { authenticate } from '../middleware/auth.ts';
import { CUT_DAY_ONLY_CREDIT, createInstrumentBody, patchInstrumentBody } from '../schemas.ts';

export const instrumentsRouter = Router();
instrumentsRouter.use(authenticate);

const COLS = 'id, type, bank, last4, label, billing_cut_day, archived_at, created_at, updated_at';

export const instrumentOut = (r: any) => ({
  id: r.id,
  type: r.type,
  bank: r.bank,
  last4: r.last4,
  label: r.label,
  billingCutDay: r.billing_cut_day,
  archived: r.archived_at !== null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// Los instrumentos son privados de cada usuario (RLS por grupo y usuario).
instrumentsRouter.get('/', async (req, res) => {
  const q = z.object({ includeArchived: boolParam }).parse(req.query);
  const rows = await withTenant(req.auth, async (c) => {
    const r = await c.query(
      `SELECT ${COLS} FROM instruments WHERE ($1::boolean OR archived_at IS NULL) ORDER BY type, lower(bank), last4`,
      [q.includeArchived ?? false],
    );
    return r.rows;
  });
  res.json({ items: rows.map(instrumentOut) });
});

instrumentsRouter.post('/', async (req, res) => {
  const b = createInstrumentBody.parse(req.body);
  const row = await withTenant(req.auth, async (c) => {
    const r = await c.query(
      `INSERT INTO instruments (household_id, user_id, type, bank, last4, label, billing_cut_day) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [req.auth.householdId, req.auth.userId, b.type, b.bank, b.last4, b.label ?? null, b.billingCutDay ?? null],
    );
    return r.rows[0];
  });
  res.status(201).json(instrumentOut(row));
});

instrumentsRouter.patch('/:id', async (req, res) => {
  const id = idParam(req);
  const b = patchInstrumentBody.parse(req.body);
  const row = await withTenant(req.auth, async (c) => {
    const cur = await c.query(`SELECT type FROM instruments WHERE id = $1`, [id]);
    if (!cur.rows[0]) throw notFound('Instrumento');
    // Si deja de ser tarjeta de crédito pierde el día de corte (y sus movimientos vuelven al mes calendario).
    let billingCutDay = b.billingCutDay;
    if ((b.type ?? cur.rows[0].type) !== 'tarjeta_credito') {
      if (billingCutDay != null) throw new HttpError(400, 'validation_error', CUT_DAY_ONLY_CREDIT);
      if (b.type) billingCutDay = null;
    }
    const set = buildSet(
      { type: b.type, bank: b.bank, last4: b.last4, label: b.label, billing_cut_day: billingCutDay },
      b.archived === undefined ? [] : [b.archived ? 'archived_at = COALESCE(archived_at, now())' : 'archived_at = NULL'],
    );
    if (set.empty) throw new HttpError(400, 'validation_error', 'Nada que actualizar');
    const r = await c.query(`UPDATE instruments SET ${set.sql} WHERE id = $${set.next} RETURNING ${COLS}`, [...set.params, id]);
    if (!r.rows[0]) throw notFound('Instrumento');
    return r.rows[0];
  });
  res.json(instrumentOut(row));
});

// DELETE = archivar: los movimientos conservan su instrumento.
instrumentsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req);
  const n = await withTenant(req.auth, async (c) => {
    const r = await c.query(`UPDATE instruments SET archived_at = COALESCE(archived_at, now()) WHERE id = $1`, [id]);
    return r.rowCount;
  });
  if (!n) throw notFound('Instrumento');
  res.status(204).end();
});
