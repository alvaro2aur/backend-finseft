-- 002 — Tokens de dispositivo (importación desde app-expense-tracker) e índice para detectar posibles duplicados.
-- Para bases creadas con una versión anterior de init-schema.sql (las nuevas ya lo incluyen).
-- Ejecutar como superusuario:  psql -d fintseft -f migrations/002_device_tokens.sql
BEGIN;
SET search_path = common, public;

-- Tokens de dispositivo (app Android): se crean desde la web, se guarda solo el hash.
-- Sin RLS: se consultan para autenticar, antes de conocer el grupo (igual que refresh_tokens).
CREATE TABLE device_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  token_prefix text NOT NULL,                  -- primeros caracteres, para reconocerlo en la lista
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  FOREIGN KEY (user_id, household_id) REFERENCES users (id, household_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX device_tokens_user ON device_tokens (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_tokens TO finseft_app;

-- Detección de posibles duplicados al importar (mismo instrumento y monto, fecha ± 1 día)
CREATE INDEX txn_user_instr_amount_date ON transactions (user_id, instrument_id, amount, occurred_on) WHERE deleted_at IS NULL;

COMMIT;
