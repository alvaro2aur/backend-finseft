import { config } from '../config.ts';
import { HttpError } from '../errors.ts';

/** Fecha de hoy ('YYYY-MM-DD') en la zona horaria de la app. */
export function todayISO(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const pad = (n: number) => String(n).padStart(2, '0');
const monthStr = (y: number, m: number) => `${y}-${pad(m)}`;

export interface MonthInfo {
  month: string;
  from: string; // primer día (incluido)
  to: string; // primer día del mes siguiente (excluido)
  prevFrom: string;
  prevTo: string;
  daysInMonth: number;
  daysElapsed: number; // días transcurridos incluyendo hoy (0 si el mes es futuro)
}

export function monthInfo(month?: string, today = todayISO()): MonthInfo {
  const m = month ?? today.slice(0, 7);
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(m);
  if (!match) throw new HttpError(400, 'validation_error', 'month debe tener formato YYYY-MM');
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const next = mo === 12 ? monthStr(y + 1, 1) : monthStr(y, mo + 1);
  const prev = mo === 1 ? monthStr(y - 1, 12) : monthStr(y, mo - 1);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const cur = today.slice(0, 7);
  const daysElapsed = m < cur ? daysInMonth : m > cur ? 0 : Number(today.slice(8, 10));
  return { month: m, from: `${m}-01`, to: `${next}-01`, prevFrom: `${prev}-01`, prevTo: `${m}-01`, daysInMonth, daysElapsed };
}
