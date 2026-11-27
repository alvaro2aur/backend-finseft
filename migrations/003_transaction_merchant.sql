-- 003 — Comercio de cada movimiento (columna propia) y descripción opcional.
-- Para bases creadas con una versión anterior de init-schema.sql (las nuevas ya lo incluyen).
-- Ejecutar como superusuario:  psql -d fintseft -f migrations/003_transaction_merchant.sql
BEGIN;
SET search_path = common, public;

ALTER TABLE transactions
  ADD COLUMN merchant text,
  ALTER COLUMN description DROP NOT NULL;

-- Las compras ya importadas desde la app guardaban el comercio en la descripción ("Compra con tarjeta ····1234"
-- si no venía; en otra moneda, con la nota del monto original al final). Se copia a merchant y la descripción
-- queda como está. Se desactiva el trigger de updated_at para no marcarlas como editadas.
ALTER TABLE transactions DISABLE TRIGGER transactions_set_updated_at;
UPDATE transactions
   SET merchant = nullif(btrim(regexp_replace(description, ' · [A-Z]{3} .*\(monto original, ajustar a pesos\)$', '')), '')
 WHERE source = 'app-android' AND merchant IS NULL AND description NOT LIKE 'Compra con tarjeta ····%';
ALTER TABLE transactions ENABLE TRIGGER transactions_set_updated_at;

COMMIT;
