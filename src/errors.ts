import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, 'not_found', `${what} no encontrado`);

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(new HttpError(404, 'not_found', 'Ruta no encontrada'));

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Datos inválidos',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'JSON inválido' } });
  }
  // Errores de Postgres
  switch (err?.code) {
    case '23505':
      return res.status(409).json({ error: { code: 'conflict', message: 'Ya existe un registro igual' } });
    case '23503':
      return res.status(422).json({ error: { code: 'invalid_reference', message: 'Referencia inválida (categoría, instrumento u otro dato no existe o no te pertenece)' } });
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
      return res.status(400).json({ error: { code: 'invalid_value', message: 'Valor inválido' } });
    case '42501':
      return res.status(403).json({ error: { code: 'forbidden', message: 'No tienes permiso para esa operación' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Error interno' } });
};
