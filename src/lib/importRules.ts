// Reglas puras de la importación desde la app (sin base de datos).

/** CLP se registra tal cual. Otra moneda llega en centésimas (como la guarda la app) y se pasa a pesos, mínimo $1. */
export function toClpAmount(amountMinor: number, currency: string): number {
  return currency === 'CLP' ? amountMinor : Math.max(1, Math.round(amountMinor / 100));
}

/**
 * La descripción que escribió el usuario en la app (ya normalizada por el esquema: null si no escribió nada).
 * En otra moneda se agrega el monto original, para recordar ajustarlo a pesos.
 */
export function importDescription(description: string | null | undefined, amountMinor: number, currency: string): string | null {
  const base = description ?? null;
  if (currency === 'CLP') return base;
  const original = (amountMinor / 100).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const note = `${currency} ${original} (monto original, ajustar a pesos)`;
  return base ? `${base} · ${note}` : note;
}

/** Fecha 'YYYY-MM-DD' de un instante ISO 8601 en la zona horaria dada. */
export function localDate(isoDateTime: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoDateTime));
}

/**
 * Clave para comparar comercios: minúsculas, sin espacios sobrantes; el espacio no separable (NBSP)
 * cuenta como espacio. Debe dar lo mismo que MERCHANT_SQL.
 */
export function normalizeMerchant(s: string): string {
  return s.replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * La misma normalización en SQL. El comercio es `transactions.merchant`; los movimientos sin comercio
 * (los digitados a mano) usan su descripción, quitando la nota de moneda de las importaciones antiguas
 * ("… · USD 12,34 (monto original, ajustar a pesos)"). En Postgres `\s` y `trim()` no tratan el NBSP como
 * espacio, por eso se traduce explícitamente (chr(160)).
 */
export const MERCHANT_SQL = String.raw`lower(regexp_replace(btrim(translate(COALESCE(t.merchant, regexp_replace(t.description, ' · [A-Z]{3} .*\(monto original, ajustar a pesos\)$', '')), chr(160), ' ')), '[[:space:]]+', ' ', 'g'))`;
