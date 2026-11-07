import { Router } from 'express';
import { withTenant } from '../db.ts';
import { todayISO } from '../lib/dates.ts';
import { authenticate } from '../middleware/auth.ts';

export const periodsRouter = Router();
periodsRouter.use(authenticate);

/**
 * Mes de presupuesto "en curso": el mayor entre el mes calendario de hoy y el período actual de cada
 * tarjeta con corte. Ej.: el 28 de octubre, con una tarjeta que corta el 26, es noviembre — las compras
 * de hoy ya cuentan en noviembre. Los clientes lo usan como mes por defecto.
 */
periodsRouter.get('/current', async (req, res) => {
  const row = await withTenant(req.auth, async (c) => {
    const { rows } = await c.query(
      `SELECT to_char(GREATEST(date_trunc('month', $1::timestamp)::date, COALESCE(MAX(period_month($1::date, billing_cut_day)), '0001-01-01'::date)), 'YYYY-MM') AS month
         FROM instruments WHERE archived_at IS NULL AND billing_cut_day IS NOT NULL`,
      [todayISO()],
    );
    return rows[0];
  });
  res.json({ month: row.month });
});
