import { Router } from 'express';
import { buildOpenApi } from './document.ts';

export { buildOpenApi };

// El documento es estático: se arma una vez al arrancar.
const document = buildOpenApi();

export const openapiRouter = Router();
openapiRouter.get('/openapi.json', (_req, res) => {
  res.json(document);
});
