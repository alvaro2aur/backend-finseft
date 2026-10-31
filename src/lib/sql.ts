/**
 * Arma "col = $n, ..." para un UPDATE parcial. Los nombres de columna salen del código
 * (nunca del request); los valores `undefined` se omiten.
 */
export function buildSet(cols: Record<string, unknown>, extra: string[] = []) {
  const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
  const parts = keys.map((k, i) => `${k} = $${i + 1}`).concat(extra);
  return { sql: parts.join(', '), params: keys.map((k) => cols[k]), next: keys.length + 1, empty: parts.length === 0 };
}
