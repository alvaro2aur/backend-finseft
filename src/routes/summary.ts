import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Db } from '../db.ts';
import { monthInfo, type MonthInfo } from '../lib/dates.ts';
import { monthStr } from '../lib/validate.ts';
import { authenticate } from '../middleware/auth.ts';
import { TXN_SELECT, txnOut } from './transactions.ts';

export const summaryRouter = Router();
summaryRouter.use(authenticate);

const pct = (spent: number, budget: number) => (budget > 0 ? Math.round((spent * 100) / budget) : null);

/** budget 0 = sin límite: no hay porcentaje ni "queda". */
function categoryLine(c: { id: string; name: string; kind: string; budget: number; archived_at: unknown }, scope: 'personal' | 'shared', spent: number, mySpent: number) {
  const hasLimit = c.budget > 0;
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    scope,
    archived: c.archived_at !== null,
    budget: c.budget,
    spent,
    mySpent,
    pct: pct(spent, c.budget),
    over: hasLimit && spent > c.budget,
    left: hasLimit ? c.budget - spent : null,
  };
}

function budgetTotals(lines: { budget: number; spent: number }[], m: MonthInfo) {
  const budget = lines.reduce((a, l) => a + l.budget, 0);
  const spent = lines.reduce((a, l) => a + l.spent, 0);
  const available = budget - spent;
  // Días que quedan después de hoy; en el último día o en un mes cerrado no hay "por día".
  const remaining = m.daysElapsed === 0 ? m.daysInMonth : m.daysInMonth - m.daysElapsed;
  return { budget, spent, usedPct: pct(spent, budget), available, perDayAllowed: remaining > 0 ? Math.floor(Math.max(available, 0) / remaining) : null };
}

const vsPrevious = (current: number, previous: number) => ({
  previous,
  amount: current - previous,
  pct: previous > 0 ? Math.round(((current - previous) * 1000) / previous) / 10 : null,
});

const dailyAvg = (total: number, m: MonthInfo) => (m.daysElapsed > 0 ? Math.floor(total / m.daysElapsed) : 0);
const monthMeta = (m: MonthInfo) => ({ month: m.month, daysInMonth: m.daysInMonth, daysElapsed: m.daysElapsed });

const query = z.object({ month: monthStr.optional() });

async function ownSpendByCategory(c: Db, from: string, to: string, currency: string) {
  const { rows } = await c.query(
    `SELECT category_id, sum(amount)::bigint AS spent FROM transactions
      WHERE type = 'egreso' AND deleted_at IS NULL AND currency = $3 AND occurred_on >= $1 AND occurred_on < $2
      GROUP BY category_id`,
    [from, to, currency],
  );
  return new Map<string | null, number>(rows.map((r) => [r.category_id, r.spent]));
}

// Resumen personal: categorías personales con su presupuesto, más todo lo propio del usuario.
summaryRouter.get('/personal', async (req, res) => {
  const m = monthInfo(query.parse(req.query).month);
  const cur = req.auth.currency;
  const d = await withTenant(req.auth, async (c) => {
    const cats = (await c.query(`SELECT id, user_id, name, kind, budget, archived_at FROM categories`)).rows;
    const spent = await ownSpendByCategory(c, m.from, m.to, cur);
    const prev = await ownSpendByCategory(c, m.prevFrom, m.prevTo, cur);
    const income = (
      await c.query(
        `SELECT COALESCE(sum(amount), 0)::bigint AS v FROM transactions
          WHERE type = 'ingreso' AND deleted_at IS NULL AND currency = $3 AND occurred_on >= $1 AND occurred_on < $2`,
        [m.from, m.to, cur],
      )
    ).rows[0].v as number;
    const recent = (await c.query(`${TXN_SELECT} WHERE t.deleted_at IS NULL ORDER BY t.occurred_on DESC, t.created_at DESC, t.id LIMIT 5`)).rows;
    return { cats, spent, prev, income, recent };
  });

  const sum = (mp: Map<string | null, number>) => [...mp.values()].reduce((a, b) => a + b, 0);
  const kindOf = new Map<string, string>(d.cats.map((c) => [c.id, c.kind]));
  const withoutFixed = (mp: Map<string | null, number>) =>
    [...mp.entries()].reduce((a, [id, v]) => a + (id !== null && kindOf.get(id) === 'fija' ? 0 : v), 0);

  const personal = d.cats
    .filter((c) => c.user_id !== null && (c.archived_at === null || (d.spent.get(c.id) ?? 0) > 0))
    .map((c) => categoryLine(c, 'personal', d.spent.get(c.id) ?? 0, d.spent.get(c.id) ?? 0))
    .sort((a, b) => b.budget - a.budget || a.name.localeCompare(b.name, 'es'));
  const sharedContribution = d.cats
    .filter((c) => c.user_id === null && (d.spent.get(c.id) ?? 0) > 0)
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind, mySpent: d.spent.get(c.id)! }))
    .sort((a, b) => b.mySpent - a.mySpent);

  const expense = sum(d.spent);
  const prevExpense = sum(d.prev);
  const savings = d.income - expense;
  res.json({
    ...monthMeta(m),
    currency: cur,
    totals: {
      ...budgetTotals(personal, m), // presupuesto: solo categorías personales
      income: d.income, // el resto: todo lo del usuario (personal + su parte en compartidas + sin categoría)
      expense,
      savings,
      savingsPct: d.income > 0 ? Math.round((savings * 100) / d.income) : null,
      dailyAverage: dailyAvg(expense, m),
      dailyAverageWithoutFixed: dailyAvg(withoutFixed(d.spent), m),
      vsPreviousMonth: vsPrevious(expense, prevExpense),
    },
    categories: personal,
    sharedContribution,
    uncategorized: { mySpent: d.spent.get(null) ?? 0 },
    recent: d.recent.map(txnOut),
  });
});

// Resumen del grupo: solo categorías compartidas. Gasto del grupo vía group_category_spend (solo totales).
summaryRouter.get('/household', async (req, res) => {
  const m = monthInfo(query.parse(req.query).month);
  const cur = req.auth.currency;
  const d = await withTenant(req.auth, async (c) => {
    const cats = (await c.query(`SELECT id, user_id, name, kind, budget, archived_at FROM categories WHERE user_id IS NULL`)).rows;
    const agg = async (from: string, to: string) =>
      new Map<string, { group: number; mine: number }>(
        (await c.query(`SELECT category_id, group_spent, my_spent FROM group_category_spend($1, $2) WHERE currency = $3`, [from, to, cur])).rows.map(
          (r) => [r.category_id, { group: r.group_spent, mine: r.my_spent }],
        ),
      );
    const spent = await agg(m.from, m.to);
    const prev = await agg(m.prevFrom, m.prevTo);
    const members = (await c.query(`SELECT count(*)::int AS n FROM users WHERE household_id = $1`, [req.auth.householdId])).rows[0].n as number;
    return { cats, spent, prev, members };
  });

  const lines = d.cats
    .filter((c) => c.archived_at === null || (d.spent.get(c.id)?.group ?? 0) > 0)
    .map((c) => categoryLine(c, 'shared', d.spent.get(c.id)?.group ?? 0, d.spent.get(c.id)?.mine ?? 0))
    .sort((a, b) => b.budget - a.budget || a.name.localeCompare(b.name, 'es'));
  const kindOf = new Map<string, string>(d.cats.map((c) => [c.id, c.kind]));
  const groupTotal = (mp: Map<string, { group: number }>) => [...mp.values()].reduce((a, v) => a + v.group, 0);
  const groupWithoutFixed = [...d.spent.entries()].reduce((a, [id, v]) => a + (kindOf.get(id) === 'fija' ? 0 : v.group), 0);
  const totals = budgetTotals(lines, m);

  res.json({
    ...monthMeta(m),
    currency: cur,
    memberCount: d.members,
    totals: {
      ...totals,
      mySpent: lines.reduce((a, l) => a + l.mySpent, 0),
      dailyAverage: dailyAvg(totals.spent, m),
      dailyAverageWithoutFixed: dailyAvg(groupWithoutFixed, m),
      vsPreviousMonth: vsPrevious(totals.spent, groupTotal(d.prev)),
    },
    categories: lines,
  });
});
