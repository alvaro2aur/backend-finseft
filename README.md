# FinSelf API

API de finanzas personales y familiares. Bun + Express 5 + TypeScript, Postgres con aislamiento por grupo
mediante Row-Level Security (ver `init-schema.sql`).

## Puesta en marcha

```bash
bun install
cp .env.example .env        # y completa los valores
bun run dev                 # http://localhost:3000
```

Variables (ver `.env.example`): la API se conecta como **`finseft_app`**, un rol sin `BYPASSRLS`
(`APP_DB_USER`/`APP_DB_PASS`). **No uses el superusuario**: se salta RLS y rompe el aislamiento.
`POSTGRES_USER`/`POSTGRES_PASS` (superusuario) solo se usan para recrear el schema y en las pruebas.

Crear/recrear el schema: `init-schema.sql` (en `psql`, precedido de `DROP SCHEMA common CASCADE;` si ya existe).
Habilitar el login del rol de la API: `ALTER ROLE finseft_app LOGIN PASSWORD '...';`

```bash
bun test          # pruebas de integración contra la base fintseft_test (se recrea sola)
bun run typecheck
```

### Migraciones

`init-schema.sql` crea siempre el esquema completo. Las bases creadas con una versión anterior se actualizan con
los archivos de `migrations/`, en orden y como superusuario:

```bash
psql -h localhost -U <superusuario> -d fintseft -f migrations/001_billing_cut_day.sql
```

| Migración | Qué agrega |
|---|---|
| `001_billing_cut_day.sql` | Día de corte en tarjetas de crédito y mes de presupuesto (`budget_month`) en movimientos |
| `002_device_tokens.sql` | Tokens de dispositivo (importación desde la app) e índice para detectar posibles duplicados |

## Cómo funciona el aislamiento

Cada request autenticada abre una transacción y fija `app.household_id` y `app.user_id` (`src/db.ts → withTenant`);
las políticas RLS hacen el resto. El access token solo lleva el id del usuario: el grupo y el rol se leen de la base
en cada request, así cambiar de grupo no deja tokens desactualizados.

- **Categorías**: compartidas (`scope: "shared"`, visibles para todo el grupo) o personales (`"personal"`).
- **Instrumentos y movimientos**: privados de cada usuario.
- **Gasto del grupo** en categorías compartidas: solo como totales, vía `group_category_spend` (nunca filas ajenas).

## Convenciones

- Errores: `{ "error": { "code", "message", "details?" } }`. 400 validación, 401 sin sesión, 403 permiso, 404 no existe
  (también para lo que pertenece a otro usuario), 409 conflicto (duplicados, reglas de grupo), 422 referencia inválida.
- Montos: enteros en la moneda base (pesos), siempre positivos; el signo lo da `type`.
- Fechas: `YYYY-MM-DD`; meses: `YYYY-MM`.
- Valores de enums en minúscula: `kind`: `fija|variable`; `type` de movimiento: `ingreso|egreso`;
  `type` de instrumento: `cuenta_corriente|tarjeta_debito|tarjeta_credito`; `scope`: `personal|shared`.
- Autorización: `Authorization: Bearer <accessToken>` (15 min). Renovar con `/auth/refresh` (rota el token).

## Períodos de facturación

Cada movimiento tiene un **mes de presupuesto** (`budgetMonth`). Por defecto es el mes calendario de su fecha; si se pagó
con una tarjeta de crédito que tiene **día de corte**, es su período de facturación: hasta el día de corte (incluido)
cuenta en ese mes y desde el día siguiente, en el siguiente (corte 26: una compra del 27 de octubre es de noviembre).
Si el mes no tiene ese día (corte 31 en febrero) se usa su último día.

- Lo calcula la base (`period_month`) con triggers: al crear o editar un movimiento, y al cambiar el corte de una
  tarjeta (se reimputan todos sus movimientos).
- El filtro `month` de `/transactions` y los resúmenes usan el mes de presupuesto; `from`/`to` siguen siendo fechas.
- `GET /periods/current` da el mes en curso considerando los cortes; los clientes lo usan como mes por defecto.
- Limitación: los días transcurridos y el "por día" del resumen usan el mes calendario, porque con cortes distintos por
  tarjeta no hay un único ciclo. Los ingresos en cuenta corriente siguen por mes calendario.

## Importación desde la app (`app-expense-tracker`)

La app Android registra compras capturadas de las notificaciones del banco. Diseño:
`docs/superpowers/specs/2026-11-07-importacion-app-design.md`.

- **Token de dispositivo** (`fsd_…`): se crea en la web (`POST /devices`; se muestra una sola vez) y se revoca con
  `DELETE /devices/:id`. Solo sirve para `GET /categories`, `GET /instruments`, `POST /imports/transactions` y
  `POST /imports/suggestions`; cualquier otra ruta responde 403.
- **`POST /imports/transactions`**: lote de hasta 200 compras, idempotente por `externalId`. Cada compra vuelve como
  `created`, `exists`, `discarded` (importada y luego borrada en FinSelf), `rejected` (con motivo) o
  `possible_duplicate` (se parece a una digitada a mano: misma tarjeta y monto a ±1 día; se registra igual reenviándola
  con `confirmDuplicate: true`).
- **`POST /imports/suggestions`**: categoría más usada por comercio en los últimos 12 meses.
- **Limitación:** la app envía solo desde la red de la casa, por HTTP (`http://192.168.100.10:8090/api`), así que el
  token viaja sin cifrar por el wifi. No exponer estas rutas a internet sin HTTPS.

## Contrato OpenAPI

La API publica su contrato (OpenAPI 3.1) en **`GET /openapi.json`**, y una copia versionada en [`openapi.json`](openapi.json).
Es la fuente de verdad para los clientes: el front genera sus tipos desde aquí en vez de copiarlos a mano.

```bash
# En el repo del front (con la API arriba):
bunx openapi-typescript http://localhost:3000/openapi.json -o src/api/schema.d.ts
```

- Los **cuerpos de request** se derivan de los esquemas de validación (`src/schemas.ts`), los mismos que usan las rutas.
- Las **respuestas** se describen en `src/openapi/document.ts`. Las pruebas de integración validan **cada respuesta real**
  contra ese documento (`test/contract.ts`): un campo nuevo, faltante o de otro tipo hace fallar la prueba.
- Una prueba comprueba que los endpoints documentados sean exactamente los que existen (`src/routes/index.ts`) y otra,
  que `openapi.json` esté al día.

Al agregar o cambiar un endpoint: ajusta el esquema en `src/schemas.ts` si recibe cuerpo, descríbelo en
`src/openapi/document.ts`, registra su router en `src/routes/index.ts` y ejecuta:

```bash
bun run openapi:export   # regenera openapi.json
bun test
```

## Endpoints

### Autenticación (sin token)
| Método | Ruta | Cuerpo |
|---|---|---|
| POST | `/auth/register` | `email, password (≥8), displayName?` → `{user, accessToken, refreshToken, expiresIn}` |
| POST | `/auth/login` | `email, password` |
| POST | `/auth/google` | `idToken` (ID token de Google Identity Services; requiere `GOOGLE_CLIENT_ID`) |
| POST | `/auth/refresh` | `refreshToken` — rota; reutilizar uno viejo cierra toda la sesión |
| POST | `/auth/logout` | `refreshToken` |
| POST | `/auth/forgot-password` | `email` → siempre 204 |
| POST | `/auth/reset-password` | `token, password` → 204; cierra todas las sesiones |

### Cuenta y grupo (con token)
| Método | Ruta | Notas |
|---|---|---|
| GET / PATCH | `/me` | `displayName`, `currency` |
| GET | `/household` | grupo y miembros |
| PATCH | `/household` | `name` (owner) |
| PATCH | `/household/members/:id` | `role` (owner); siempre debe quedar un owner |
| GET / POST | `/household/invitations` | owner; POST `email, role?` envía el correo |
| DELETE | `/household/invitations/:id` | owner |
| POST | `/household/invitations/accept` | `token`; el correo debe coincidir con el de la cuenta |
| POST | `/household/leave` | pasa a un grupo nuevo propio |

### Datos (con token)
| Método | Ruta | Notas |
|---|---|---|
| GET | `/categories` | `?includeArchived&scope` |
| POST | `/categories` | `name, kind?, budget?, scope?` (compartidas: solo owner) |
| PATCH | `/categories/:id` | `name, kind, budget, archived` (el alcance no cambia) |
| DELETE | `/categories/:id` | archiva |
| GET / POST | `/instruments` | `type, bank, last4, label?` |
| PATCH / DELETE | `/instruments/:id` | DELETE archiva |
| GET | `/transactions` | filtros `month, from, to, categoryId (uuid\|none), q, type, instrumentId, minAmount`; `sortBy` (`date,category,description,type,instrument,amount`), `sortDir`, `page`, `pageSize (≤100)` → `{items, page, pageSize, total, totals{income,expense,balance}}` (totales del conjunto filtrado) |
| GET / POST | `/transactions` `/transactions/:id` | POST: `date, type, amount, description, instrumentId, categoryId?, currency?` |
| PATCH / DELETE | `/transactions/:id` | DELETE es lógico |
| GET | `/summary/personal?month=YYYY-MM` | presupuesto de categorías personales + todo lo propio (ingresos, ahorro, promedios, vs. mes anterior completo, aporte a compartidas, últimos movimientos) |
| GET | `/summary/household?month=YYYY-MM` | categorías compartidas con gasto del grupo y `mySpent`; sin ingresos ni movimientos |
| GET | `/health` | |

## Decisiones que tomé (revisables)

- Solo los **owners** crean, editan y archivan categorías compartidas; cualquier miembro las usa.
- Un owner no puede irse si es el único owner y quedan más miembros (debe promover a otro antes).
- Al cambiar de grupo, los movimientos con categoría compartida quedan **sin categoría**; las categorías personales,
  instrumentos y movimientos del usuario lo siguen. Si el grupo anterior queda vacío, se elimina.
- El refresh token se entrega en el cuerpo JSON (no en cookie httpOnly) para no atar el front a un mismo origen.
- Recuperación de contraseña e invitaciones envían un enlace por correo; **aún no hay proveedor**: en desarrollo el
  correo se imprime en consola (`src/lib/mailer.ts`). Hay que conectar SMTP o una API de correo antes de producción.
- Los resúmenes consideran solo la moneda base del usuario (`users.currency`); el multi-moneda queda para después.
- `perDayAllowed` divide lo disponible entre los días que quedan **después de hoy**; es `null` en meses cerrados.
