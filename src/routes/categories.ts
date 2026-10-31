import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { buildSet } from '../lib/sql.ts';
import { boolParam, idParam } from '../lib/validate.ts';
import { authenticate, requireOwner } from '../middleware/auth.ts';
import { categoryScope, createCategoryBody, patchCategoryBody } from '../schemas.ts';

export const categoriesRouter = Router();
categoriesRouter.use(authenticate);

const COLS = 'id, user_id, name, kind, budget, archived_at, created_at, updated_at';

export const categoryOut = (r: any) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  scope: r.user_id ? 'personal' : 'shared',
  budget: r.budget,
  archived: r.archived_at !== null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// RLS entrega las compartidas del grupo y las personales del usuario; las demás no existen para él.
categoriesRouter.get('/', async (req, res) => {
  const q = z
    .object({ includeArchived: boolParam, scope: categoryScope.optional() })
    .parse(req.query);
  const rows = await withTenant(req.auth, async (c) => {
    const r = await c.query(
      `SELECT ${COLS} FROM categories
        WHERE ($1::boolean OR archived_at IS NULL)
          AND ($2::text IS NULL OR ($2 = 'shared') = (user_id IS NULL))
        ORDER BY lower(name), id`,
      [q.includeArchived ?? false, q.scope ?? null],
    );
    return r.rows;
  });
  res.json({ items: rows.map(categoryOut) });
});

categoriesRouter.post('/', async (req, res) => {
  const b = createCategoryBody.parse(req.body);
  // Quién puede crear/editar categorías compartidas lo decide la API (decisión: solo owners).
  if (b.scope === 'shared') requireOwner(req);
  const row = await withTenant(req.auth, async (c) => {
    const r = await c.query(
      `INSERT INTO categories (household_id, user_id, name, kind, budget) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
      [req.auth.householdId, b.scope === 'personal' ? req.auth.userId : null, b.name, b.kind, b.budget],
    );
    return r.rows[0];
  });
  res.status(201).json(categoryOut(row));
});

categoriesRouter.patch('/:id', async (req, res) => {
  const id = idParam(req);
  const b = patchCategoryBody.parse(req.body);
  const row = await withTenant(req.auth, async (c) => {
    const cur = await c.query(`SELECT user_id FROM categories WHERE id = $1`, [id]);
    if (!cur.rows[0]) throw notFound('Categoría');
    if (cur.rows[0].user_id === null) requireOwner(req);
    const set = buildSet({ name: b.name, kind: b.kind, budget: b.budget }, b.archived === undefined ? [] : [b.archived ? 'archived_at = COALESCE(archived_at, now())' : 'archived_at = NULL']);
    if (set.empty) throw new HttpError(400, 'validation_error', 'Nada que actualizar');
    const r = await c.query(`UPDATE categories SET ${set.sql} WHERE id = $${set.next} RETURNING ${COLS}`, [...set.params, id]);
    return r.rows[0];
  });
  res.json(categoryOut(row));
});

// DELETE = archivar: los movimientos conservan su categoría y el nombre se sigue mostrando.
categoriesRouter.delete('/:id', async (req, res) => {
  const id = idParam(req);
  await withTenant(req.auth, async (c) => {
    const cur = await c.query(`SELECT user_id FROM categories WHERE id = $1`, [id]);
    if (!cur.rows[0]) throw notFound('Categoría');
    if (cur.rows[0].user_id === null) requireOwner(req);
    await c.query(`UPDATE categories SET archived_at = COALESCE(archived_at, now()) WHERE id = $1`, [id]);
  });
  res.status(204).end();
});
