import { Router } from 'express';
import type { z } from 'zod';
import { config } from '../config.ts';
import { withTenant, type Db } from '../db.ts';
import { todayISO } from '../lib/dates.ts';
import { importDescription, localDate, MERCHANT_SQL, normalizeMerchant, toClpAmount } from '../lib/importRules.ts';
import { authenticate, type AuthCtx } from '../middleware/auth.ts';
import { importBody, importItem, suggestionsBody } from '../schemas.ts';

// Importación de compras capturadas por la app Android (token de dispositivo o sesión de usuario).
export const importsRouter = Router();
importsRouter.use(authenticate);

const SOURCE = 'app-android';

type Status = 'created' | 'exists' | 'discarded' | 'rejected' | 'possible_duplicate';
interface ItemResult {
  index: number;
  externalId?: string;
  status: Status;
  transactionId?: string;
  budgetMonth?: string;
  error?: { code: string; message: string; details?: unknown };
  matches?: { transactionId: string; date: string; amount: number; description: string; categoryName: string | null }[];
}

const reject = (base: Pick<ItemResult, 'index' | 'externalId'>, code: string, message: string, details?: unknown): ItemResult => ({
  ...base,
  status: 'rejected',
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

/**
 * Procesa una compra. Orden: validación → repetida en el lote → ya importada (por externalId) →
 * instrumento → categoría → posible duplicado de una digitada a mano → crear. `seen` guarda el primer resultado de cada externalId del lote.
 */
/** Ya importada antes (por externalId), aunque después se haya borrado en FinSelf. */
async function findImported(c: Db, auth: AuthCtx, base: Pick<ItemResult, 'index' | 'externalId'>): Promise<ItemResult | null> {
  const { rows } = await c.query(
    `SELECT id, to_char(budget_month, 'YYYY-MM') AS budget_month, deleted_at IS NOT NULL AS deleted
       FROM transactions WHERE user_id = $1 AND source = $2 AND external_ref = $3`,
    [auth.userId, SOURCE, base.externalId],
  );
  const ex = rows[0];
  if (!ex) return null;
  return ex.deleted ? { ...base, status: 'discarded', transactionId: ex.id } : { ...base, status: 'exists', transactionId: ex.id, budgetMonth: ex.budget_month };
}

async function importOne(c: Db, auth: AuthCtx, raw: unknown, index: number, seen: Map<string, ItemResult>): Promise<ItemResult> {
  const parsed = importItem.safeParse(raw);
  if (!parsed.success) {
    const extId = (raw as { externalId?: unknown } | null)?.externalId;
    const details = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return reject({ index, ...(typeof extId === 'string' ? { externalId: extId } : {}) }, 'invalid_item', 'Datos inválidos', details);
  }
  const it = parsed.data;
  const base = { index, externalId: it.externalId };

  const earlier = seen.get(it.externalId);
  if (earlier?.transactionId) return { ...base, status: 'exists', transactionId: earlier.transactionId, budgetMonth: earlier.budgetMonth };

  // Todo lo que toca la base va en un savepoint: un error de una compra no aborta el lote.
  await c.query('SAVEPOINT import_item');
  try {
    const r = await importValid(c, auth, it, base);
    await c.query('RELEASE SAVEPOINT import_item');
    return r;
  } catch (e: any) {
    await c.query('ROLLBACK TO SAVEPOINT import_item');
    await c.query('RELEASE SAVEPOINT import_item');
    const code = typeof e?.code === 'string' ? e.code : '';
    // Otro envío simultáneo del mismo lote la registró primero: ya está.
    if (code === '23505') {
      const again = await findImported(c, auth, base);
      if (again) return again;
    }
    if (code.startsWith('22') || code.startsWith('23')) return reject(base, 'invalid_item', 'La base rechazó la compra');
    throw e;
  }
}

async function importValid(c: Db, auth: AuthCtx, it: z.infer<typeof importItem>, base: Pick<ItemResult, 'index' | 'externalId'>): Promise<ItemResult> {
  const imported = await findImported(c, auth, base);
  if (imported) return imported;

  const instruments = (await c.query(`SELECT id, type FROM instruments WHERE archived_at IS NULL AND last4 = $1`, [it.cardLast4])).rows;
  if (!instruments.length) {
    return reject(base, 'unknown_card', `No hay una tarjeta ····${it.cardLast4} en FinSelf. Créala en Instrumentos.`);
  }
  const credit = instruments.filter((i) => i.type === 'tarjeta_credito');
  const candidates = credit.length ? credit : instruments;
  if (candidates.length > 1) {
    return reject(base, 'ambiguous_card', `Hay más de una tarjeta ····${it.cardLast4} en FinSelf; deja activa solo una.`);
  }
  const instrumentId = candidates[0].id as string;

  // RLS: solo son visibles las compartidas del grupo y las personales del usuario.
  const category = await c.query(`SELECT 1 FROM categories WHERE id = $1 AND archived_at IS NULL`, [it.categoryId]);
  if (!category.rowCount) return reject(base, 'invalid_category', 'La categoría no existe, está archivada o no es tuya.');

  const date = localDate(it.purchasedAt, config.timezone);
  const amount = toClpAmount(it.amountMinor, it.currency);

  // ¿Ya la digitó a mano? Misma tarjeta y monto, a ±1 día. Sin confirmación no se crea: decide el usuario.
  if (!it.confirmDuplicate) {
    const similar = await c.query(
      `SELECT t.id, t.occurred_on, t.amount, t.description, c.name AS category_name
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = $1 AND t.source = 'manual' AND t.deleted_at IS NULL
          AND t.instrument_id = $2 AND t.amount = $3
          AND t.occurred_on BETWEEN $4::date - 1 AND $4::date + 1
        ORDER BY abs(t.occurred_on - $4::date), t.occurred_on
        LIMIT 5`,
      [auth.userId, instrumentId, amount, date],
    );
    if (similar.rowCount) {
      return {
        ...base,
        status: 'possible_duplicate',
        matches: similar.rows.map((r) => ({ transactionId: r.id, date: r.occurred_on, amount: r.amount, description: r.description, categoryName: r.category_name })),
      };
    }
  }

  const { rows } = await c.query(
    `INSERT INTO transactions (household_id, user_id, occurred_on, type, amount, currency, category_id, instrument_id, description, source, external_ref)
     VALUES ($1, $2, $3, 'egreso', $4, 'CLP', $5, $6, $7, $8, $9)
     RETURNING id, to_char(budget_month, 'YYYY-MM') AS budget_month`,
    [auth.householdId, auth.userId, date, amount, it.categoryId, instrumentId, importDescription(it.merchant, it.cardLast4, it.amountMinor, it.currency), SOURCE, it.externalId],
  );
  return { ...base, status: 'created', transactionId: rows[0].id, budgetMonth: rows[0].budget_month };
}

importsRouter.post('/transactions', async (req, res) => {
  const { items } = importBody.parse(req.body);
  const results = await withTenant(req.auth, async (c) => {
    const seen = new Map<string, ItemResult>();
    const out: ItemResult[] = [];
    for (const [index, raw] of items.entries()) {
      const r = await importOne(c, req.auth, raw, index, seen);
      if (r.externalId && !seen.has(r.externalId)) seen.set(r.externalId, r);
      out.push(r);
    }
    return out;
  });
  const summary: Record<Status, number> = { created: 0, exists: 0, discarded: 0, rejected: 0, possible_duplicate: 0 };
  for (const r of results) summary[r.status]++;
  res.json({ results, summary });
});

/**
 * Sugerencia de categoría por comercio, desde los movimientos propios del usuario (RLS) de los últimos
 * 12 meses: la categoría más usada para ese comercio; ante empate, la usada más recientemente.
 */
importsRouter.post('/suggestions', async (req, res) => {
  const { merchants } = suggestionsBody.parse(req.body);
  const keys = merchants.map(normalizeMerchant);
  const rows = await withTenant(req.auth, async (c) => {
    const r = await c.query(
      `WITH hist AS (
         SELECT ${MERCHANT_SQL} AS merchant, t.category_id, count(*)::int AS uses, max(t.occurred_on) AS last_on
           FROM transactions t JOIN categories c ON c.id = t.category_id
          WHERE t.user_id = $2 AND t.deleted_at IS NULL AND c.archived_at IS NULL
            AND t.occurred_on >= $3::date - interval '12 months'
          GROUP BY 1, 2
       )
       SELECT DISTINCT ON (merchant) merchant, category_id, uses
         FROM hist WHERE merchant = ANY($1::text[])
        ORDER BY merchant, uses DESC, last_on DESC`,
      [keys, req.auth.userId, todayISO()],
    );
    return r.rows;
  });
  const best = new Map<string, { category_id: string; uses: number }>(rows.map((r) => [r.merchant, r]));
  res.json({
    suggestions: merchants.map((merchant, i) => {
      const hit = best.get(keys[i]!);
      return { merchant, categoryId: hit?.category_id ?? null, uses: hit?.uses ?? 0 };
    }),
  });
});
