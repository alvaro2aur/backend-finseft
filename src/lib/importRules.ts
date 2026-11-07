// Reglas puras de la importación desde la app (sin base de datos).

/** CLP se registra tal cual. Otra moneda llega en centésimas (como la guarda la app) y se pasa a pesos, mínimo $1. */
export function toClpAmount(amountMinor: number, currency: string): number {
  return currency === 'CLP' ? amountMinor : Math.max(1, Math.round(amountMinor / 100));
}

/** El comercio; sin comercio, la tarjeta. En otra moneda se agrega el monto original para ajustarlo después. */
export function importDescription(merchant: string | null | undefined, last4: string, amountMinor: number, currency: string): string {
  const base = merchant?.trim() || `Compra con tarjeta ····${last4}`;
  if (currency === 'CLP') return base;
  const original = (amountMinor / 100).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${base} · ${currency} ${original} (monto original, ajustar a pesos)`;
}

/** Fecha 'YYYY-MM-DD' de un instante ISO 8601 en la zona horaria dada. */
export function localDate(isoDateTime: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoDateTime));
}

/** Clave para comparar comercios: minúsculas, sin espacios sobrantes. Debe coincidir con MERCHANT_SQL. */
export function normalizeMerchant(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * La misma normalización en SQL sobre `transactions.description`, quitando antes la nota de moneda que
 * agrega importDescription ("… · USD 12,34 (monto original, ajustar a pesos)").
 */
export const MERCHANT_SQL = String.raw`lower(regexp_replace(regexp_replace(trim(t.description), ' · [A-Z]{3} .*\(monto original, ajustar a pesos\)$', ''), '\s+', ' ', 'g'))`;
