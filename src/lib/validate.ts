import type { Request } from 'express';
import { z } from 'zod';

export const uuid = z.string().uuid();

/** Valida `req.params.id` como uuid (evita errores 22P02 de Postgres). */
export const idParam = (req: Request): string => uuid.parse(req.params.id);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)), 'Fecha inválida');
export const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes con formato YYYY-MM');

/** Query param booleano: 'true' | '1'. */
export const boolParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
