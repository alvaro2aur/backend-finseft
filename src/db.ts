import pg from 'pg';
import { config } from './config.ts';

// bigint (int8) y count() llegan como número; los montos son enteros en pesos.
pg.types.setTypeParser(20, (v) => Number(v));
// date llega como 'YYYY-MM-DD', sin pasar por Date (evita desfases de zona horaria).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  options: `-c search_path=${config.db.schema},public`,
  max: 10,
});

export type Db = pg.PoolClient;

/** Transacción simple, sin contexto de grupo (flujos de autenticación). */
export async function tx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export interface TenantCtx {
  userId: string;
  householdId: string;
}

/**
 * Transacción con el contexto de grupo y usuario fijado para RLS (set_config local a la
 * transacción: no se filtra a otras requests aunque la conexión vuelva al pool).
 */
export function withTenant<T>(ctx: TenantCtx, fn: (c: Db) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    await c.query(`SELECT set_config('app.household_id', $1, true), set_config('app.user_id', $2, true)`, [
      ctx.householdId,
      ctx.userId,
    ]);
    return fn(c);
  });
}
