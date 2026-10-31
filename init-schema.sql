-- Extensiones (fuera del schema common para que sobrevivan a un DROP SCHEMA common)
CREATE EXTENSION IF NOT EXISTS citext SCHEMA public;

CREATE SCHEMA IF NOT EXISTS common;
SET search_path = common, public;

-- Rol de la API: no es dueño de las tablas y no puede saltarse RLS.
-- Se habilita para conectarse con: ALTER ROLE finseft_app LOGIN PASSWORD '...';
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'finseft_app') THEN
    CREATE ROLE finseft_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Tipos
CREATE TYPE auth_provider     AS ENUM ('google', 'password');
CREATE TYPE category_kind     AS ENUM ('fija', 'variable');
CREATE TYPE txn_type          AS ENUM ('ingreso', 'egreso');
CREATE TYPE instrument_kind   AS ENUM ('cuenta_corriente', 'tarjeta_debito', 'tarjeta_credito');
CREATE TYPE household_role    AS ENUM ('owner', 'member');

-- Mantiene updated_at al día en cada UPDATE
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Contexto de la request. La API lo fija por transacción, después de validar la sesión:
--   SELECT set_config('app.household_id', '<uuid>', true), set_config('app.user_id', '<uuid>', true);
-- Sin contexto devuelven NULL y las políticas RLS no dejan ver ni escribir filas.
CREATE FUNCTION current_household() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.household_id', true), '')::uuid $$;

CREATE FUNCTION current_app_user() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Grupos familiares (unidad de aislamiento). Todo usuario pertenece a exactamente uno:
-- al registrarse se crea su grupo y queda como owner; luego puede aceptar una invitación.
CREATE TABLE households (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Usuarios e inicio de sesión (Google o correo)
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id   uuid NOT NULL REFERENCES households(id),   -- sin cascade: se borran primero los usuarios
  household_role household_role NOT NULL DEFAULT 'owner',
  email          citext NOT NULL UNIQUE,
  display_name   text,
  currency       char(3) NOT NULL DEFAULT 'CLP',             -- moneda base del usuario
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, household_id)    -- destino de las FK compuestas de las tablas con datos
);
CREATE INDEX users_household ON users (household_id);

-- Invitaciones para unirse a un grupo (se acepta por token, antes de tener contexto de grupo)
CREATE TABLE household_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  invited_by   uuid NOT NULL,
  email        citext NOT NULL,
  role         household_role NOT NULL DEFAULT 'member',
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  FOREIGN KEY (invited_by, household_id) REFERENCES users (id, household_id) ON UPDATE CASCADE
);
CREATE INDEX household_invitations_household ON household_invitations (household_id);

CREATE TABLE user_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      auth_provider NOT NULL,
  provider_sub  text,          -- "sub" de Google
  password_hash text,          -- solo para provider = 'password'
  UNIQUE (provider, provider_sub),
  UNIQUE (user_id, provider),  -- una identidad por proveedor y usuario
  CHECK (provider <> 'password' OR password_hash IS NOT NULL),
  CHECK (provider <> 'google'   OR provider_sub  IS NOT NULL)
);

-- Refresh tokens (se guarda solo el hash; family_id permite detectar reutilización al rotar)
CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id      uuid NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  replaced_by_id uuid REFERENCES refresh_tokens(id),
  user_agent     text,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX refresh_tokens_user   ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

-- Recuperación de contraseña ("¿La olvidaste?")
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX password_reset_tokens_user ON password_reset_tokens (user_id);

-- Categorías (pantalla Categorías), con su presupuesto (valor actual). Dos alcances:
--   compartida: user_id IS NULL     -> la ven y usan todos los miembros del grupo
--   personal:   user_id = <usuario> -> solo su dueño
-- DELETE desde la API = archivar; los movimientos conservan su categoría archivada.
CREATE TABLE categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      uuid,
  name         text NOT NULL,
  kind         category_kind NOT NULL DEFAULT 'variable',
  budget       bigint NOT NULL DEFAULT 0 CHECK (budget >= 0),   -- 0 = sin límite
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, household_id),    -- destino de la FK compuesta desde transactions
  -- las personales siguen a su dueño si cambia de grupo (con user_id NULL no se evalúa)
  FOREIGN KEY (user_id, household_id) REFERENCES users (id, household_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX categories_shared_name_uq
  ON categories (household_id, lower(name)) WHERE user_id IS NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX categories_personal_name_uq
  ON categories (user_id, lower(name)) WHERE user_id IS NOT NULL AND archived_at IS NULL;
CREATE TRIGGER categories_set_updated_at
  BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Instrumentos bancarios: privados de cada usuario
CREATE TABLE instruments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  type         instrument_kind NOT NULL,
  bank         text NOT NULL,
  last4        char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),   -- nunca el número completo
  label        text,                                             -- alias opcional del usuario
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),     -- destino de la FK compuesta desde transactions
  -- si el usuario cambia de grupo, sus instrumentos lo siguen
  FOREIGN KEY (user_id, household_id) REFERENCES users (id, household_id)
    ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX instruments_user_uq
  ON instruments (user_id, type, lower(bank), last4) WHERE archived_at IS NULL;
CREATE TRIGGER instruments_set_updated_at
  BEFORE UPDATE ON instruments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Movimientos (pantalla Movimientos): privados de cada usuario
CREATE TABLE transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  occurred_on   date NOT NULL,
  type          txn_type NOT NULL,
  amount        bigint NOT NULL CHECK (amount > 0),   -- siempre positivo; el signo lo da type
  currency      char(3) NOT NULL DEFAULT 'CLP',       -- multi-moneda a futuro
  category_id   uuid,                                 -- NULL = "Sin categoría"
  instrument_id uuid NOT NULL,
  description   text NOT NULL,
  source        text NOT NULL DEFAULT 'manual',       -- manual | telegram | import
  external_ref  text,                                 -- para no duplicar importaciones
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (user_id, source, external_ref),
  -- el movimiento sigue al usuario si cambia de grupo
  FOREIGN KEY (user_id, household_id) REFERENCES users (id, household_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  -- categoría del mismo grupo (con category_id NULL no se evalúa). Las categorías personales
  -- se mueven junto con el usuario; si usa una compartida, la API debe poner category_id = NULL
  -- antes de cambiarlo de grupo.
  FOREIGN KEY (category_id, household_id) REFERENCES categories (id, household_id),
  -- instrumento del mismo usuario
  FOREIGN KEY (instrument_id, user_id)    REFERENCES instruments (id, user_id)
);
CREATE INDEX txn_user_date       ON transactions (user_id, occurred_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX txn_user_cat_date   ON transactions (user_id, category_id, occurred_on) WHERE deleted_at IS NULL;
CREATE INDEX txn_user_instr_date ON transactions (user_id, instrument_id, occurred_on) WHERE deleted_at IS NULL;
CREATE TRIGGER transactions_set_updated_at
  BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Una categoría personal solo puede usarla su dueño (las FK no revisan el user_id de la categoría).
-- Corre como finseft_stats (BYPASSRLS): con los permisos de quien escribe, RLS le ocultaría
-- las categorías personales de otros y el chequeo las dejaría pasar.
CREATE FUNCTION check_category_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = common, public AS $$
BEGIN
  IF NEW.category_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM categories c
    WHERE c.id = NEW.category_id AND c.user_id IS NOT NULL AND c.user_id <> NEW.user_id
  ) THEN
    RAISE EXCEPTION 'la categoría % es personal de otro usuario', NEW.category_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transactions_check_category
  BEFORE INSERT OR UPDATE OF category_id, user_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION check_category_owner();

-- Gasto agregado de las categorías compartidas del grupo, sumando a todos los miembros.
-- Los movimientos son privados, así que esto corre como un rol propio (finseft_stats, con
-- BYPASSRLS y solo SELECT en transactions y categories) y devuelve únicamente totales.
-- El grupo sale del contexto de la request (app.household_id). p_to es exclusivo.
-- El gasto de las categorías personales lo calcula la API con consultas normales (RLS).
CREATE FUNCTION group_category_spend(p_from date, p_to date)
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
    AND t.occurred_on >= p_from AND t.occurred_on < p_to
  GROUP BY t.category_id, t.currency
$$;

-- Row-Level Security: aislamiento por grupo (categorías) y por usuario (instrumentos y movimientos).
-- FORCE aplica las políticas también al dueño de las tablas; los superusuarios igual se las saltan,
-- por eso la API debe conectarse como finseft_app.
ALTER TABLE categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories   FORCE  ROW LEVEL SECURITY;
ALTER TABLE instruments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE instruments  FORCE  ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE  ROW LEVEL SECURITY;

-- Cada usuario ve las compartidas de su grupo y sus categorías personales.
-- Quién puede crear o editar las compartidas (cualquier miembro u owner) lo decide la API.
CREATE POLICY categories_visible ON categories
  USING      (household_id = current_household() AND (user_id IS NULL OR user_id = current_app_user()))
  WITH CHECK (household_id = current_household() AND (user_id IS NULL OR user_id = current_app_user()));

CREATE POLICY instruments_owner ON instruments
  USING      (household_id = current_household() AND user_id = current_app_user())
  WITH CHECK (household_id = current_household() AND user_id = current_app_user());

CREATE POLICY transactions_owner ON transactions
  USING      (household_id = current_household() AND user_id = current_app_user())
  WITH CHECK (household_id = current_household() AND user_id = current_app_user());

-- Rol interno para los agregados del grupo (ver group_category_spend)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'finseft_stats') THEN
    CREATE ROLE finseft_stats NOLOGIN BYPASSRLS;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA common TO finseft_stats;
GRANT SELECT ON transactions, categories TO finseft_stats;
ALTER FUNCTION group_category_spend(date, date) OWNER TO finseft_stats;
ALTER FUNCTION check_category_owner() OWNER TO finseft_stats;
REVOKE ALL ON FUNCTION group_category_spend(date, date) FROM PUBLIC;

-- Permisos del rol de la API. Las tablas de autenticación (users, user_identities, tokens,
-- invitaciones) se consultan antes de conocer el grupo, así que no llevan RLS.
GRANT USAGE ON SCHEMA common TO finseft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA common TO finseft_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA common TO finseft_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA common
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO finseft_app;
