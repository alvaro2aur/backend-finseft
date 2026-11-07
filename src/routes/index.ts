import type { Router } from 'express';
import { openapiRouter } from '../openapi/index.ts';
import { authRouter, meRouter } from './auth.ts';
import { categoriesRouter } from './categories.ts';
import { devicesRouter } from './devices.ts';
import { healthRouter } from './health.ts';
import { householdRouter } from './household.ts';
import { importsRouter } from './imports.ts';
import { instrumentsRouter } from './instruments.ts';
import { periodsRouter } from './periods.ts';
import { summaryRouter } from './summary.ts';
import { transactionsRouter } from './transactions.ts';

/**
 * Routers y su prefijo. La app los monta desde aquí, y las pruebas recorren esta misma lista para
 * comprobar que cada endpoint real está documentado en el OpenAPI (y al revés).
 */
export const mounts: [prefix: string, router: Router][] = [
  ['', healthRouter],
  ['', openapiRouter],
  ['/auth', authRouter],
  ['/me', meRouter],
  ['/household', householdRouter],
  ['/categories', categoriesRouter],
  ['/instruments', instrumentsRouter],
  ['/transactions', transactionsRouter],
  ['/summary', summaryRouter],
  ['/periods', periodsRouter],
  ['/devices', devicesRouter],
  ['/imports', importsRouter],
];
