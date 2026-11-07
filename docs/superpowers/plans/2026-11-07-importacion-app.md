# Importación desde app-expense-tracker — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La app Android puede autenticarse con un token de dispositivo, leer categorías e instrumentos, pedir
sugerencias de categoría e importar compras en lote a FinSelf sin duplicarlas.

**Architecture:** Tabla `device_tokens` y un segundo modo en el middleware `authenticate` (`kind: 'device'`, con lista
blanca de rutas). Un router `/imports` con dos endpoints, apoyado en funciones puras (`src/lib/importRules.ts`), que
procesa cada compra en su propio `SAVEPOINT` dentro de `withTenant`. La pantalla "Dispositivos" va en `web-finseft`.

**Tech Stack:** Bun 1.4 + Express 5 + zod 4 + pg (backend, `bun test`); React 19 + TanStack Query + Vitest (web).

**Spec:** `docs/superpowers/specs/2026-11-07-importacion-app-design.md`

## Global Constraints

- Prefijo del token: `fsd_`. Se muestra una sola vez; en la base solo se guarda `sha256` (`src/lib/tokens.ts`).
- Rutas aceptadas con token de dispositivo, exactamente: `GET /categories`, `GET /instruments`,
  `POST /imports/transactions`, `POST /imports/suggestions`. Cualquier otra → 403 `forbidden`.
- Lote máximo: 200 elementos en `items` y en `merchants`.
- `source = 'app-android'`, `type = 'egreso'`, `external_ref = externalId`.
- Estados: `created`, `exists`, `discarded`, `rejected`, `possible_duplicate`.
  Códigos de rechazo: `invalid_item`, `unknown_card`, `ambiguous_card`, `invalid_category`.
- Moneda distinta de CLP: `amount = max(1, round(amountMinor / 100))`, `currency = 'CLP'`, y la descripción termina en
  `· {CUR} {monto con 2 decimales es-CL} (monto original, ajustar a pesos)`.
- Descripción sin comercio: `Compra con tarjeta ····{last4}`.
- Posible duplicado: movimiento vigente, `source = 'manual'`, mismo `instrument_id`, mismo `amount`, `occurred_on` en
  [fecha − 1 día, fecha + 1 día]. Sin columna de hash.
- `occurred_on` = fecha local de `purchasedAt` en `config.timezone` (America/Santiago).
- Todo cambio de esquema va en `init-schema.sql` **y** en `migrations/002_device_tokens.sql`.
- Toda respuesta nueva queda en `src/openapi/document.ts`; las pruebas validan el contrato (`test/contract.ts`), y
  `openapi.json` se regenera con `bun run openapi:export`.
- Commits sin línea `Co-Authored-By` (preferencia del usuario).
- **Antes de la Tarea 1:** hay trabajo sin commitear en ambos repos (períodos de facturación y despliegue). Pedir al
  usuario que lo commitee, o autorización para hacerlo, para que este trabajo quede en commits propios.

## Review Focus

1. **Token revocado mientras la app está en uso:** la petición siguiente debe responder 401, no seguir funcionando → prueba en Tarea 2.
2. **Token de dispositivo en una ruta no permitida**, de lectura (`GET /transactions`) o de escritura (`DELETE /categories/:id`) → 403 → prueba en Tarea 2.
3. **Compra cerca de medianoche:** `2026-11-03T02:30:00Z` es el 2 de noviembre a las 23:30 en Chile, y debe quedar `occurred_on = 2026-11-02` → prueba en Tarea 3.
4. **El mismo `externalId` dos veces en un lote:** el primero queda `created` y el segundo `exists` → prueba en Tarea 3.
5. **Instrumento archivado con esos `last4`:** no se usa, y la compra es `unknown_card`. Una categoría personal de otro miembro del grupo es `invalid_category` → pruebas en Tarea 3.

---

### Task 1: Esquema — tokens de dispositivo e índice de duplicados

**Files:**
- Modify: `init-schema.sql` (después de `password_reset_tokens`; índice junto a los `txn_user_*`)
- Create: `migrations/002_device_tokens.sql`
- Modify: `README.md` (tabla de migraciones)

**Interfaces:**
- Produces: tabla `common.device_tokens(id uuid pk, household_id uuid, user_id uuid, name text not null, token_hash text unique not null, token_prefix text not null, created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)`, con FK `(user_id, household_id) → users(id, household_id) ON UPDATE CASCADE ON DELETE CASCADE`. **Sin RLS**: se consulta antes de conocer el grupo, igual que `refresh_tokens`.
- Produces: índice `txn_user_instr_amount_date ON transactions (user_id, instrument_id, amount, occurred_on) WHERE deleted_at IS NULL`.

- [ ] **Step 1:** Agregar tabla e índice a `init-schema.sql`. Escribir `002_device_tokens.sql` con lo mismo, más `GRANT SELECT, INSERT, UPDATE, DELETE ON device_tokens TO finseft_app`, dentro de `BEGIN/COMMIT` y con `SET search_path = common, public` (mismo formato que `001`).
- [ ] **Step 2:** Comprobar que ambos caminos dan el mismo esquema, como con la 001. Usar dos bases temporales: (A) `git show HEAD:init-schema.sql` + 001 + 002, y (B) `init-schema.sql` nuevo. Comparar `pg_dump -s -n common`.
  Expected: solo difieren las líneas `\restrict`/`\unrestrict`. Borrar las bases temporales.
- [ ] **Step 3:** `bun test` → los 44 existentes pasan (el preload recrea `fintseft_test` con el esquema nuevo).
- [ ] **Step 4:** Commit `feat(db): tokens de dispositivo e índice para posibles duplicados`.

### Task 2: Tokens de dispositivo — API y autenticación

**Files:**
- Create: `src/lib/deviceTokens.ts`, `src/routes/devices.ts`, `test/devices.test.ts`
- Modify: `src/middleware/auth.ts`, `src/routes/index.ts` (montar `['/devices', devicesRouter]`), `src/schemas.ts`, `src/openapi/document.ts`

**Interfaces:**
- Produces `src/lib/deviceTokens.ts`:
  - `DEVICE_TOKEN_PREFIX = 'fsd_'`
  - `newDeviceToken(): { token: string; hash: string; prefix: string }`: `token = 'fsd_' + randomToken()`, `prefix = token.slice(0, 12)`.
- Produces `AuthCtx` con `kind: 'user' | 'device'` y `deviceId?: string`.
- Produces en `src/middleware/auth.ts`:
  - `DEVICE_ROUTES: ReadonlySet<string>` con las 4 claves `"METHOD /ruta"` de Global Constraints;
  - `routeKey(req): string`, que da `` `${req.method} ${req.baseUrl}${req.path === '/' ? '' : req.path}` ``.
- Produces `src/schemas.ts`: `createDeviceBody = z.object({ name: z.string().trim().min(1).max(60) })`.
- Produces la salida de dispositivo: `{ id, name, prefix, createdAt, lastUsedAt: string|null, revoked: boolean }`. `POST` agrega `token`.
- Produces las rutas, solo con sesión de usuario: `GET /devices` → `{ items }`, `POST /devices` → 201, `DELETE /devices/:id` → 204 (marca `revoked_at`; 404 si no es suyo).

- [ ] **Step 1: Pruebas que fallan** en `test/devices.test.ts`:
  - `crear, listar y usar un token`:
    - `POST /devices` → 201 con `token` que empieza con `fsd_`;
    - `GET /devices` no incluye `token` y muestra `prefix`;
    - con el token, `GET /categories` y `GET /instruments` → 200;
    - después del uso, `lastUsedAt` no es null.
  - `el token de dispositivo no sirve fuera de su lista` (Review Focus 2): `GET /transactions`, `DELETE /categories/:id`, `GET /devices`, `GET /me` → 403 `forbidden`.
  - `revocar corta el acceso de inmediato` (Review Focus 1): tras `DELETE /devices/:id` → 204, `GET /categories` con ese token → 401 `invalid_token`.
  - `tokens ajenos o inventados`: `fsd_xxx` → 401. Otro usuario no ve ni revoca el dispositivo (`DELETE` → 404).
  - `un token de dispositivo no crea dispositivos`: `POST /devices` con token de dispositivo → 403.
- [ ] **Step 2:** `bun test test/devices.test.ts` → FAIL (404 en `/devices`).
- [ ] **Step 3: Implementar.**
  - En `authenticate`: si el bearer empieza con `fsd_`, buscar por `sha256` con `JOIN users`, `revoked_at IS NULL` (si no → 401 `invalid_token`). Si `routeKey(req)` no está en `DEVICE_ROUTES` → 403 `forbidden`. Actualizar `last_used_at` solo si es NULL o tiene más de 60 s.
  - Con JWT, `kind: 'user'`.
  - Las rutas de `/devices` exigen `kind === 'user'`.
- [ ] **Step 4: OpenAPI.**
  - Nuevo esquema de seguridad `deviceToken` (`http`/`bearer`, `bearerFormat: 'fsd_…'`).
  - `Op.device?: boolean`; con `device: true`, `security` queda `[{ bearerAuth: [] }, { deviceToken: [] }]`. Marcar `listCategories` y `listInstruments`.
  - `op()` agrega `Forbidden` a toda operación con `auth !== false`, porque un token de dispositivo puede llegar a cualquiera.
  - Documentar los tres paths de `/devices` (etiqueta "Dispositivos"), con esquemas `Device`, `DeviceList` y `CreatedDevice`.
- [ ] **Step 5:** `bun test` → todo pasa, incluidos `openapi.test.ts` (cobertura de rutas) y el contrato.
- [ ] **Step 6:** Commit `feat: tokens de dispositivo con acceso limitado`.

### Task 3: `POST /imports/transactions` — registro, idempotencia y rechazos

**Files:**
- Create: `src/lib/importRules.ts`, `src/routes/imports.ts`, `test/importRules.test.ts`, `test/imports.test.ts`
- Modify: `src/schemas.ts`, `src/routes/index.ts` (montar `['/imports', importsRouter]`), `src/openapi/document.ts`

**Interfaces:**
- Produces `src/lib/importRules.ts` (funciones puras):
  - `toClpAmount(amountMinor: number, currency: string): number`
  - `importDescription(merchant: string | undefined, last4: string, amountMinor: number, currency: string): string`
  - `localDate(isoDateTime: string, tz: string): string` → `'YYYY-MM-DD'`
- Produces `src/schemas.ts`:
  - `importItem` (zod, campos de la tabla del spec, `confirmDuplicate` opcional);
  - `importBody = z.object({ items: z.array(z.unknown()).min(1).max(200) })`. Cada elemento se valida aparte con `importItem.safeParse`, para devolver `invalid_item` sin romper el lote.
- Produces el resultado de cada elemento: `{ index, externalId?, status, transactionId?, budgetMonth?, error?: { code, message, details? }, matches? }`, más `summary` con los 5 estados en 0 si no hay. `matches` lo llena la Tarea 4.

- [ ] **Step 1: Pruebas unitarias** en `test/importRules.test.ts`:
  - `toClpAmount(42380, 'CLP') === 42380`
  - `toClpAmount(1234, 'USD') === 12`
  - `toClpAmount(40, 'USD') === 1`
  - `importDescription('LIDER EXPRESS', '4082', 42380, 'CLP') === 'LIDER EXPRESS'`
  - `importDescription('  ', '4082', 1, 'CLP') === 'Compra con tarjeta ····4082'`
  - `importDescription('AMAZON', '4082', 1234, 'USD') === 'AMAZON · USD 12,34 (monto original, ajustar a pesos)'`
  - `localDate('2026-11-03T02:30:00Z', 'America/Santiago') === '2026-11-02'` (Review Focus 3)
  - `localDate('2026-11-03T12:00:00-03:00', 'America/Santiago') === '2026-11-03'`
- [ ] **Step 2: Pruebas de integración** en `test/imports.test.ts`, con token de dispositivo y un usuario que tiene una tarjeta de crédito `····4082` con corte 26:
  - `lote mixto`: `created` (con `budgetMonth`), `rejected/unknown_card` (`····9999`), `rejected/invalid_item` (`categoryId: 'x'`, devuelve `index` y `details`), `rejected/invalid_category` (categoría archivada). `summary` cuadra.
  - `reenviar el mismo lote no duplica`: el segundo envío devuelve `exists` con el mismo `transactionId`; `GET /transactions` cuenta 1.
  - `externalId repetido dentro del lote` (Review Focus 4): `[created, exists]`.
  - `borrado en FinSelf → discarded`: `DELETE /transactions/:id` y luego reenviar → `discarded`, sin fila nueva.
  - `tarjeta archivada no se usa` (Review Focus 5): archivar `····4082` → `unknown_card`.
  - `ambiguous_card`: dos tarjetas de crédito activas `····5555` → `ambiguous_card`. Con una de crédito y una de débito `····6666` → `created` con la de crédito.
  - `categoría personal de otro miembro` (Review Focus 5): B, del mismo grupo, importa con la categoría personal de A → `invalid_category`. Con una compartida → `created`.
  - `período por día de corte`: compra del 27-10 con corte 26 → `budgetMonth: '2026-11'`.
  - `moneda extranjera`: `USD 1234` → `amount 12`, `currency 'CLP'`, descripción con la nota.
  - `lote inválido`: `{ items: [] }`, 201 elementos o `items` que no es lista → 400 `validation_error`.
- [ ] **Step 3:** `bun test test/importRules.test.ts test/imports.test.ts` → FAIL.
- [ ] **Step 4: Implementar.**
  - `importRules.ts`: `localDate` con `Intl.DateTimeFormat('en-CA', { timeZone })`; la nota de moneda con `toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`.
  - `imports.ts`: dentro de un solo `withTenant(req.auth, …)`, cada elemento en `SAVEPOINT item` / `ROLLBACK TO SAVEPOINT item` ante error de BD (un 23503/23505 inesperado → `rejected/invalid_item`).
  - Orden por elemento: validación → `externalId` ya visto en el lote → existente por `(source, external_ref)`, incluidos borrados (`exists` o `discarded`) → instrumento (`archived_at IS NULL AND last4 = $1`, preferir `tarjeta_credito`) → categoría (visible por RLS y no archivada) → [Tarea 4] → `INSERT … RETURNING id, to_char(budget_month,'YYYY-MM')`.
  - La búsqueda de existentes no debe filtrar `deleted_at`.
- [ ] **Step 5: OpenAPI.**
  - Body `ImportTransactionsRequest`: `items` como lista de `ImportItem`, derivado de zod (`importItem`) para documentar los campos aunque la validación sea por elemento.
  - Respuesta `ImportResult`; etiqueta "Importación"; `device: true`.
  - Regenerar `openapi.json`.
- [ ] **Step 6:** `bun test` → todo pasa.
- [ ] **Step 7:** Commit `feat: importación de compras por lote desde la app`.

### Task 4: Posibles duplicados

**Files:**
- Modify: `src/routes/imports.ts`, `src/openapi/document.ts`, `test/imports.test.ts`

**Interfaces:**
- Consumes: el orden de procesamiento de la Tarea 3; el paso "[Tarea 4]" va justo antes del `INSERT`.
- Produces `matches: { transactionId, date, amount, description, categoryName: string|null }[]` en los resultados `possible_duplicate`.

- [ ] **Step 1: Pruebas** en `test/imports.test.ts`, con un movimiento manual de $12.490 el 2026-11-03 en `····4082`:
  - Compras del 02-11, 03-11 y 04-11 por 12490 → `possible_duplicate`, con `matches[0].transactionId` igual al manual.
  - El 05-11 → `created`. Por 12491 → `created`. Con otra tarjeta → `created`.
  - Reenviar con `confirmDuplicate: true` → `created`.
  - Un manual borrado no cuenta → `created`.
  - Un movimiento importado parecido (`source 'app-android'`) no cuenta → `created`.
  - Un `possible_duplicate` no crea fila (el conteo de `GET /transactions` no cambia).
- [ ] **Step 2:** `bun test test/imports.test.ts` → FAIL.
- [ ] **Step 3: Implementar** la consulta (`source = 'manual'`, `deleted_at IS NULL`, mismo `instrument_id` y `amount`, `occurred_on BETWEEN $d::date - 1 AND $d::date + 1`) usando el índice de la Tarea 1. Se omite si viene `confirmDuplicate: true`.
- [ ] **Step 4: OpenAPI:** estado y `matches` en `ImportResult`; `summary.possible_duplicate`; descripción de `confirmDuplicate`.
- [ ] **Step 5:** `bun test` → todo pasa. Commit `feat: detección de posibles duplicados al importar`.

### Task 5: `POST /imports/suggestions`

**Files:**
- Modify: `src/routes/imports.ts`, `src/lib/importRules.ts`, `src/schemas.ts`, `src/openapi/document.ts`, `test/importRules.test.ts`, `test/imports.test.ts`

**Interfaces:**
- Produces:
  - `normalizeMerchant(s: string): string`: minúsculas, `trim`, espacios colapsados;
  - `suggestionsBody = z.object({ merchants: z.array(z.string().max(200)).min(1).max(200) })`;
  - respuesta `{ suggestions: { merchant, categoryId: string|null, uses: number }[] }`, en el mismo orden.

- [ ] **Step 1: Pruebas.**
  - Unitaria: `normalizeMerchant('  Lider   EXPRESS ') === 'lider express'`.
  - Integración:
    - con 3 movimientos "LIDER EXPRESS" en Mercadería y 1 en Otros → `{ categoryId: mercaderia, uses: 3 }`;
    - empate 1–1 → la categoría del más reciente;
    - un comercio sin historial → `null, uses 0`;
    - movimientos de más de 12 meses, de categoría archivada o borrados no cuentan;
    - un importado con nota de moneda (`'AMAZON · USD 12,34 (monto original, ajustar a pesos)'`) cuenta para `'amazon'`;
    - los movimientos de otro miembro del grupo no cuentan (RLS).
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implementar.** Una consulta por lote con `unnest($1::text[])`. La expresión SQL sobre `description` debe dar el mismo resultado que `normalizeMerchant` tras quitar la nota de moneda:
  `lower(regexp_replace(regexp_replace(trim(description), ' · [A-Z]{3} .*\(monto original, ajustar a pesos\)$', ''), '\s+', ' ', 'g'))`.
  Condiciones: `occurred_on >= current_date - interval '12 months'`, `deleted_at IS NULL`, categoría con `archived_at IS NULL`. Se elige por `count(*) desc, max(occurred_on) desc`.
- [ ] **Step 4:** OpenAPI (`device: true`), regenerar `openapi.json`, `bun test` → todo pasa. Commit `feat: sugerencias de categoría por comercio`.

### Task 6: Desplegar en la Orange Pi

**Files:**
- Modify: `README.md` (sección de importación: rutas permitidas por token, contrato para la app, limitación HTTP en la red local)

- [ ] **Step 1: Documentar** en el README y verificar con `bun test` y `bunx tsc --noEmit`.
- [ ] **Step 2: Desplegar** según `deploy/README.md`:
  - `rsync` del backend a `alvaro@192.168.100.10:finself/backend/`;
  - aplicar la migración `docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d fintseft' < backend/migrations/002_device_tokens.sql`;
  - `docker compose up -d --build api`.
  Expected: `curl http://192.168.100.10:8090/api/health` → `{"status":"ok"}`; `curl -H 'Authorization: Bearer fsd_x' …/api/categories` → 401.
- [ ] **Step 3:** Commit `docs: importación desde la app`.

### Task 7: Pantalla "Dispositivos" (repo `web-finseft`)

**Files:**
- Create: `src/pages/Devices.tsx`, `src/pages/Devices.test.tsx`
- Modify: `src/api/types.ts` (`Device`), `src/api/endpoints.ts` (`devicesApi`), `src/App.tsx` (ruta `/devices`), `src/components/AppLayout.tsx` (`NAV`: "Dispositivos")

**Interfaces:**
- Consumes: `GET/POST /devices`, `DELETE /devices/:id` (Tarea 2); `Device = { id, name, prefix, createdAt, lastUsedAt, revoked }`.
- Produces `devicesApi`:
  - `list(): Promise<Device[]>`
  - `create(name: string): Promise<Device & { token: string }>`
  - `revoke(id: string): Promise<void>`

- [ ] **Step 1: Pruebas** en `src/pages/Devices.test.tsx`:
  - `lista dispositivos con último uso y estado`;
  - `crear muestra el token una sola vez`: tras crear aparece el token y el botón "Copiar"; al cerrar el aviso, el token ya no está en el DOM;
  - `revocar pide confirmación y llama a DELETE`;
  - `nombre vacío no se envía`.
- [ ] **Step 2:** `bun run test` → FAIL.
- [ ] **Step 3: Implementar** con el estilo de `Instruments.tsx` (`Card`, `PageHeader`, `IconButton`, `ErrorBanner`, `useMutation` + `useInvalidate`). Copiar con `navigator.clipboard.writeText`. Texto del aviso: "Guárdalo ahora: no se volverá a mostrar."
- [ ] **Step 4:** `bun run test`, `bunx tsc --noEmit`, `VITE_API_URL=/api bun run build` → OK.
- [ ] **Step 5: Desplegar** con `rsync -a --delete dist/ alvaro@192.168.100.10:finself/web/`. En el navegador, `http://192.168.100.10:8090/devices` carga.
- [ ] **Step 6:** Commit `feat: pantalla de dispositivos`.
