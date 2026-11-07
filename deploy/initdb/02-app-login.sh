#!/bin/sh
# Habilita el login del rol de la API (init-schema.sql lo crea sin login).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v pass="$APP_DB_PASS" <<'EOSQL'
ALTER ROLE finseft_app LOGIN PASSWORD :'pass';
EOSQL
