import { Router } from 'express';
import { pool } from '../db.ts';
import { notFound } from '../errors.ts';
import { newDeviceToken } from '../lib/deviceTokens.ts';
import { idParam } from '../lib/validate.ts';
import { authenticate } from '../middleware/auth.ts';
import { createDeviceBody } from '../schemas.ts';

// Tokens de dispositivo (app Android). Solo con sesión de usuario: un token de dispositivo no llega
// aquí, porque `authenticate` lo rechaza fuera de DEVICE_ROUTES.
export const devicesRouter = Router();
devicesRouter.use(authenticate);

const COLS = 'id, name, token_prefix, created_at, last_used_at, revoked_at';
const deviceOut = (r: any) => ({
  id: r.id,
  name: r.name,
  prefix: r.token_prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revoked: r.revoked_at !== null,
});

devicesRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLS} FROM device_tokens WHERE user_id = $1 ORDER BY created_at DESC, id`, [req.auth.userId]);
  res.json({ items: rows.map(deviceOut) });
});

devicesRouter.post('/', async (req, res) => {
  const b = createDeviceBody.parse(req.body);
  const t = newDeviceToken();
  const { rows } = await pool.query(
    `INSERT INTO device_tokens (household_id, user_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [req.auth.householdId, req.auth.userId, b.name, t.hash, t.prefix],
  );
  // El token se muestra solo en esta respuesta.
  res.status(201).json({ ...deviceOut(rows[0]), token: t.token });
});

devicesRouter.delete('/:id', async (req, res) => {
  const r = await pool.query(`UPDATE device_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2`, [
    idParam(req),
    req.auth.userId,
  ]);
  if (!r.rowCount) throw notFound('Dispositivo');
  res.status(204).end();
});
