import { Router } from 'express';
import { pool } from '../db.ts';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});
