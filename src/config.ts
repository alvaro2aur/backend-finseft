// Bun carga .env automáticamente.
const env = process.env;

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export const config = {
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 3000),
  db: {
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5432),
    database: env.POSTGRES_DB ?? 'fintseft',
    schema: env.POSTGRES_SCHEMA ?? 'common',
    user: env.APP_DB_USER ?? 'finseft_app',
    password: required('APP_DB_PASS'),
  },
  jwtSecret: required('JWT_SECRET'),
  accessTtlSec: 15 * 60,
  refreshTtlDays: 30,
  resetTtlMin: 60,
  inviteTtlDays: 7,
  googleClientId: env.GOOGLE_CLIENT_ID || undefined,
  appUrl: (env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  corsOrigins: (env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  timezone: env.APP_TIMEZONE ?? 'America/Santiago',
};
