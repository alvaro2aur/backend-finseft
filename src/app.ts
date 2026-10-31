import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config.ts';
import { errorHandler, notFoundHandler } from './errors.ts';
import { mounts } from './routes/index.ts';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  // Freno a fuerza bruta en login, recuperación de contraseña, etc.
  if (!config.isTest) {
    app.use('/auth', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
  }

  for (const [prefix, router] of mounts) app.use(prefix, router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
