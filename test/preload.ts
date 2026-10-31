// Corre antes de las pruebas: apunta la API a fintseft_test y recrea el schema desde init-schema.sql.
// El nombre de la base está fijo a propósito: las pruebas nunca deben tocar la base real.
import { readFileSync } from 'node:fs';
import pg from 'pg';

process.env.NODE_ENV = 'test';
process.env.POSTGRES_DB = 'fintseft_test';

const admin = new pg.Client({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: 'fintseft_test',
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASS,
});
await admin.connect();
try {
  await admin.query('DROP SCHEMA IF EXISTS common CASCADE');
  await admin.query(readFileSync(new URL('../init-schema.sql', import.meta.url), 'utf8'));
} finally {
  await admin.end();
}
