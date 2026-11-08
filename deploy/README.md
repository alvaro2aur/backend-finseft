# Despliegue (Docker Compose)

Probado en una Orange Pi 3B (Armbian, arm64). Sirve igual en cualquier Linux con Docker.

| Servicio | Qué hace |
|---|---|
| `db` | Postgres 18. La primera vez crea el esquema (`init-schema.sql`) y habilita el login de `finseft_app` |
| `api` | La API (se construye desde `backend/`). Solo accesible dentro de Docker |
| `web` | Caddy: sirve el front y reenvía `/api/*` a la API. Publica `HTTP_PORT` (8090) |
| `backup` | `pg_dump` diario en `./backups` (guarda 14). Cópialos también fuera del equipo |
| `tunnel` | Opcional (`--profile funnel`): Tailscale Funnel con HTTPS público |

## Primera instalación

```bash
# en tu equipo
rsync -a deploy/ servidor:finself/
rsync -a --exclude node_modules --exclude .env --exclude .git --exclude test --exclude deploy ./ servidor:finself/backend/
(cd ../web-finseft && VITE_API_URL=/api bun run build) && rsync -a --delete ../web-finseft/dist/ servidor:finself/web/

# en el servidor
cd ~/finself
cp .env.example .env   # y completa los secretos con: openssl rand -hex 24
docker compose up -d --build
```

## Actualizar

Repite los `rsync` y luego `docker compose up -d --build`. El esquema **no** se vuelve a crear: si hay cambios de
base, aplica la migración que corresponda:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d fintseft' < backend/migrations/00X_nombre.sql
```

## Exponer a internet con Tailscale Funnel

1. Crea una cuenta en tailscale.com y, en la consola, habilita **HTTPS** y **Funnel** para tu tailnet.
2. Crea una clave de autenticación (Settings → Keys → *Generate auth key*) y pégala en `.env` como `TS_AUTHKEY`.
3. `docker compose --profile funnel up -d`
4. Agrega la URL pública (`https://finself.<tu-tailnet>.ts.net`) a `PUBLIC_URLS` y a `APP_URL`, y reinicia la API:
   `docker compose up -d api`.

> **Antes de encender Funnel:** las rutas del token de dispositivo (`/api/imports/*`, y `/api/categories` e
> `/api/instruments` con ese token) quedarían accesibles desde internet. El token viaja **sin cifrar** por el wifi de
> la casa (la app usa HTTP en la red local), así que alguien que lo capture podría usarlo desde fuera. Si se enciende
> Funnel, bloquea esas rutas para las peticiones que llegan por el túnel (Tailscale agrega la cabecera
> `Tailscale-Funnel-Request`), por ejemplo en el `Caddyfile`:
>
> ```
> @funnel_import {
> 	header Tailscale-Funnel-Request *
> 	path /api/imports/* /api/devices*
> }
> respond @funnel_import 403
> ```
>
> o revoca y recrea los tokens de dispositivo después de usarlos fuera de casa.

## Respaldos

```bash
# restaurar un respaldo sobre una base vacía
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d fintseft --clean --if-exists' < backups/fintseft-AAAAMMDD-HHMM.dump
```
