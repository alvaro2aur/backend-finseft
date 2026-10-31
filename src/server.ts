import { createApp } from './app.ts';
import { config } from './config.ts';
import { pool } from './db.ts';

const server = createApp().listen(config.port, () => {
  console.log(`API escuchando en http://localhost:${config.port}`);
});

const shutdown = () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
