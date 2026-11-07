-- 001 — Día de corte de las tarjetas de crédito y mes de presupuesto de cada movimiento.
-- Para bases creadas con una versión anterior de init-schema.sql (las nuevas ya lo incluyen).
-- Ejecutar como superusuario:  psql -d fintseft -f migrations/001_billing_cut_day.sql
BEGIN;
SET search_path = common, public;

-- Mes de presupuesto de una fecha según el día de corte de la tarjeta (primer día del mes).
-- Sin corte: el mes calendario. Con corte C: hasta el día C (incluido) es ese mes; desde C+1, el siguiente.
-- Si el mes no tiene día C (p. ej. corte 31 en febrero) se usa su último día.
CREATE FUNCTION period_month(d date, cut smallint) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN cut IS NOT NULL
     AND extract(day FROM d) > least(cut, extract(day FROM date_trunc('month', d::timestamp) + interval '1 month - 1 day'))
    THEN (date_trunc('month', d::timestamp) + interval '1 month')::date
    ELSE date_trunc('month', d::timestamp)::date
  END
$$;

ALTER TABLE instruments
  ADD COLUMN billing_cut_day smallint CHECK (billing_cut_day BETWEEN 1 AND 31),
  ADD CHECK (billing_cut_day IS NULL OR type = 'tarjeta_credito');

-- Los movimientos existentes se imputan con el corte actual de su instrumento (hoy, ninguno tiene).
-- Se desactiva el trigger de updated_at para no marcarlos como editados.
ALTER TABLE transactions ADD COLUMN budget_month date;
ALTER TABLE transactions DISABLE TRIGGER transactions_set_updated_at;
UPDATE transactions t SET budget_month = period_month(t.occurred_on, i.billing_cut_day) FROM instruments i WHERE i.id = t.instrument_id;
ALTER TABLE transactions ENABLE TRIGGER transactions_set_updated_at;
ALTER TABLE transactions
  ALTER COLUMN budget_month SET NOT NULL,
  ADD CHECK (extract(day FROM budget_month) = 1);

CREATE INDEX txn_user_budget_month ON transactions (user_id, budget_month, occurred_on DESC) WHERE deleted_at IS NULL;

CREATE FUNCTION set_budget_month() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Si el instrumento no existe o no es visible queda NULL (mes calendario) y la FK rechaza la fila.
  NEW.budget_month = period_month(NEW.occurred_on, (SELECT billing_cut_day FROM instruments WHERE id = NEW.instrument_id));
  RETURN NEW;
END;
$$;
CREATE TRIGGER transactions_set_budget_month
  BEFORE INSERT OR UPDATE OF occurred_on, instrument_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_budget_month();

-- Si cambia el día de corte de una tarjeta, se reimputan sus movimientos.
CREATE FUNCTION recompute_budget_month() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE transactions SET budget_month = period_month(occurred_on, NEW.billing_cut_day) WHERE instrument_id = NEW.id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER instruments_recompute_budget_month
  AFTER UPDATE OF billing_cut_day ON instruments
  FOR EACH ROW WHEN (OLD.billing_cut_day IS DISTINCT FROM NEW.billing_cut_day)
  EXECUTE FUNCTION recompute_budget_month();

CREATE OR REPLACE FUNCTION group_category_spend(p_from date, p_to date)
RETURNS TABLE (category_id uuid, currency char(3), group_spent bigint, my_spent bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = common, public AS $$
  SELECT t.category_id,
         t.currency,
         sum(t.amount)::bigint,
         COALESCE(sum(t.amount) FILTER (WHERE t.user_id = current_app_user()), 0)::bigint
  FROM transactions t
  JOIN categories c ON c.id = t.category_id AND c.household_id = t.household_id
  WHERE t.household_id = current_household()
    AND c.user_id IS NULL
    AND t.type = 'egreso'
    AND t.deleted_at IS NULL
    AND t.budget_month >= p_from AND t.budget_month < p_to
  GROUP BY t.category_id, t.currency
$$;

GRANT EXECUTE ON FUNCTION period_month(date, smallint), set_budget_month(), recompute_budget_month() TO finseft_app;

COMMIT;
