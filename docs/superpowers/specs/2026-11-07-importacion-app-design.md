# Importación de movimientos desde `app-expense-tracker` — diseño (backend)

Fecha: 2026-11-07 · Repos: `backend-finseft` (este diseño) y `web-finseft` (pantalla "Dispositivos").
La app Android (`app-expense-tracker`) es un proyecto aparte; aquí solo se fija el contrato que consumirá.

## Intención

Hoy el usuario registra a mano en FinSelf cada compra con tarjeta de crédito. La app Android ya captura las
notificaciones push de Itaú y guarda en SQLite: monto (`amountMinor` + `currency`), comercio, comuna, país, últimos 4
dígitos de la tarjeta (`cardLast4`), fecha de compra (`purchasedAt`), además de `postTime`, `rawText` y `kind`
(`PURCHASE` | `UNRECOGNIZED`). El objetivo es dejar de digitar: en la app el usuario asigna a cada compra una categoría de
FinSelf y, al apretar un botón, la app envía el lote al backend, que lo registra como movimientos.

## Decisiones del usuario

- **Dónde se envía:** solo desde la casa, por el wifi. La app habla directo con la Orange Pi
  (`http://192.168.100.10:8090/api`), sin Tailscale.
- **Autenticación:** **token de dispositivo**, que se genera en FinSelf web y se pega en la app. No hay login en la app.
- **Categorías:** el usuario categoriza en la app antes de enviar. Quiere **sugerencias de categoría** desde ya.
- **Compras ya digitadas a mano:** FinSelf detecta **posibles duplicados** por (fecha, monto, instrumento) y el usuario
  decide en la app. Sin columna de hash: búsqueda con un índice compuesto y tolerancia de ±1 día.
- **Otras monedas (poco frecuentes):** se envían como si fueran pesos, con una nota en la descripción.
- **Flujo:** se envía en lotes, al apretar un botón (no en segundo plano).

## Objetivos

1. Tokens de dispositivo: crear, listar y revocar desde FinSelf web, con acceso limitado.
2. La app puede leer categorías e instrumentos con ese token.
3. Endpoint de importación por lotes, idempotente, que informa el resultado de cada compra.
4. Sugerencias de categoría a partir del historial del propio usuario.
5. Todo documentado en el OpenAPI y cubierto por las pruebas de integración y de contrato existentes.

## No objetivos (en esta etapa)

- La app Android en sí (categorización, sincronización, permisos de red): es el siguiente proyecto.
- Sincronizar en segundo plano o desde fuera de la casa.
- Registrar ingresos o movimientos de otros bancos desde la app.
- Editar o borrar movimientos desde la app.
- Resolver que los pagos de tarjeta se cuenten como gasto (hallado en el análisis de noviembre; es otro tema).

## Anti-objetivos (fallaría aunque "funcione")

- **Movimientos duplicados** al reintentar un envío.
- **Compras perdidas en silencio:** toda compra rechazada debe volver a la app con un motivo legible.
- **Token de dispositivo con acceso amplio:** no puede leer movimientos, tocar la cuenta ni borrar nada.
- **Romper la autenticación actual de la web:** JWT + refresh siguen igual.

## Restricciones

- Arquitectura actual: Bun + Express 5 + Postgres con RLS por grupo y usuario (`withTenant`). La API se conecta como
  `finseft_app`, sin `BYPASSRLS`.
- La importación debe pasar por las mismas reglas que un movimiento manual: FK compuestas, trigger de categoría personal,
  `budget_month` según el día de corte (triggers existentes).
- La tabla `transactions` ya tiene `source`, `external_ref` y `UNIQUE (user_id, source, external_ref)`: se usan para la idempotencia.
- Esquema nuevo: en `init-schema.sql` **y** en una migración `migrations/002_*.sql`, que se aplica a la base de la Orange Pi.
- HTTP sin TLS dentro de la red local: el token viaja en claro por el wifi de la casa. Es aceptable por la decisión de
  usarlo solo en casa, y debe quedar escrito como limitación.

## Diseño

### 1. Tokens de dispositivo

- **Tabla** `device_tokens`: `id`, `household_id`, `user_id`, `name` (p. ej. "Pixel de Álvaro"), `token_hash` (sha256,
  único), `token_prefix` (primeros caracteres, para reconocerlo en la lista), `created_at`, `last_used_at`, `revoked_at`.
  FK compuesta `(user_id, household_id)` hacia `users` con `ON UPDATE CASCADE ON DELETE CASCADE`, como los instrumentos.
- **Formato:** prefijo fijo reconocible (p. ej. `fsd_`) más un aleatorio largo. Se muestra **una sola vez** al crearlo y se
  guarda solo su hash, igual que los refresh tokens.
- **Endpoints (sesión de usuario, JWT):**
  - `GET /devices` — lista los tokens del usuario (sin el token).
  - `POST /devices { name }` — crea y devuelve el token, una vez.
  - `DELETE /devices/:id` — revoca (marca `revoked_at`; no borra la fila).
- **Autenticación:** el middleware acepta `Authorization: Bearer <JWT>` o `Bearer fsd_…`. Con un token de dispositivo,
  `req.auth` se arma igual (usuario, grupo, rol) y se marca como `kind: 'device'`. **Solo** estas rutas aceptan
  `kind: 'device'`; todas las demás responden 403:
  - `GET /categories`
  - `GET /instruments`
  - `POST /imports/transactions`
  - `POST /imports/suggestions`
- `last_used_at` se actualiza al usarlo (basta con una actualización por minuto).

### 2. `POST /imports/transactions`

Cuerpo: `{ items: [...] }`, con hasta 200 elementos. Cada elemento:

| Campo | Tipo | Nota |
|---|---|---|
| `externalId` | string (1–200) | Identificador estable que fija la app (p. ej. hash de `postTime` + `rawText`). Es la clave de idempotencia |
| `purchasedAt` | fecha-hora ISO 8601 con zona | Si la notificación no trae fecha de compra, la app envía `postTime` |
| `amountMinor` | entero > 0 | Como lo guarda la app hoy: en CLP es el entero; en cualquier otra moneda, **centésimas** (la app multiplica por 100, ver `ItauPurchaseParser`) |
| `currency` | código ISO 4217 | |
| `merchant` | string | Puede venir vacío |
| `cardLast4` | 4 dígitos | |
| `categoryId` | uuid | Obligatorio: el usuario categoriza antes de enviar |
| `confirmDuplicate` | boolean, opcional | `true` = "regístralo aunque se parezca a uno digitado a mano" (ver posibles duplicados) |

Reglas por elemento:

- **Instrumento:** el instrumento **no archivado** del usuario con esos `last4`. Si hay más de uno, se prefiere la tarjeta
  de crédito; si aun así hay más de uno → rechazo `ambiguous_card`. Si no hay ninguno → `unknown_card`, con un mensaje del
  tipo "Crea la tarjeta ····4082 en FinSelf".
- **Categoría:** debe ser visible para el usuario (compartida de su grupo o personal suya) y no estar archivada. Si no →
  `invalid_category`.
- **Fecha:** `occurred_on` es la fecha de `purchasedAt` en la zona de la app (`APP_TIMEZONE`, America/Santiago).
- **Monto y moneda:**
  - En CLP, `amount = amountMinor`.
  - En otra moneda se registra en CLP con `amount = max(1, round(amountMinor / 100))`, y la descripción lleva la nota
    `· USD 12,34 (monto original, ajustar a pesos)`. No hay tabla de decimales por moneda: el contrato es "centésimas",
    tal como lo envía la app.
- **Descripción:** el comercio recortado. Si viene vacío: "Compra con tarjeta ····{last4}".
- **Tipo:** siempre `egreso`. **Origen:** `source = 'app-android'`, `external_ref = externalId`.
- **Idempotencia:** si ya existe un movimiento con ese `(user_id, source, external_ref)`:
  - vigente → `exists`, con su id;
  - borrado en FinSelf (`deleted_at`) → `discarded`: no se recrea, porque el usuario lo descartó a propósito.
- Cada elemento se procesa aislado: un rechazo no afecta al resto del lote.
- **Posibles duplicados (compras ya digitadas a mano):** antes de crear, se buscan movimientos **vigentes** del
  usuario con `source = 'manual'`, el **mismo instrumento**, el **mismo monto** (`amount` ya convertido) y `occurred_on`
  entre la fecha de la compra **−1 y +1 día**. Si hay alguno y el elemento no trae `confirmDuplicate: true`, **no se
  crea**: vuelve como `possible_duplicate` con los movimientos parecidos (id, fecha, monto, descripción y categoría),
  para que el usuario decida en la app:
  - "es el mismo" → la app lo marca como resuelto y no lo vuelve a enviar;
  - "es otro" → la app lo reenvía con `confirmDuplicate: true` y se crea.
  La búsqueda usa un índice compuesto, p. ej. `(user_id, instrument_id, amount, occurred_on) WHERE deleted_at IS NULL`
  (no se agrega columna de hash). No se compara contra otros importados: esos ya los cubre `externalId`. El orden de
  las verificaciones es: validación → idempotencia por `externalId` → instrumento/categoría → posible duplicado → crear.
- **Validación por elemento:** un elemento malformado (uuid inválido, `cardLast4` sin 4 dígitos, moneda o fecha inválida,
  monto ≤ 0) **no** rompe el lote: vuelve como `rejected` con código `invalid_item` y el detalle de qué campo falló.
  Cada resultado lleva `index` (posición en el lote) además de `externalId`, para poder correlacionar aunque falte
  `externalId`. Si un mismo `externalId` aparece dos veces en el lote, el segundo se trata como `exists`.

Respuesta 200 (los resultados van en el mismo orden que `items`):

```json
{
  "results": [
    { "index": 0, "externalId": "…", "status": "created", "transactionId": "uuid", "budgetMonth": "2026-11" },
    { "index": 1, "externalId": "…", "status": "exists", "transactionId": "uuid", "budgetMonth": "2026-11" },
    { "index": 2, "externalId": "…", "status": "discarded", "transactionId": "uuid" },
    { "index": 3, "externalId": "…", "status": "rejected", "error": { "code": "unknown_card", "message": "…" } },
    { "index": 4, "externalId": "…", "status": "possible_duplicate",
      "matches": [{ "transactionId": "uuid", "date": "2026-11-03", "amount": 12490, "description": "Farmacia", "categoryName": "Salud" }] }
  ],
  "summary": { "created": 1, "exists": 1, "discarded": 1, "rejected": 1, "possible_duplicate": 1 }
}
```

Para la app, `created`, `exists` y `discarded` significan "ya está en FinSelf, no reenviar". `rejected` queda pendiente
con su motivo, y `possible_duplicate` espera la decisión del usuario. Errores del lote completo (no es una lista, más de 200 elementos, JSON inválido) → 400 con el formato de error común.

### 3. `POST /imports/suggestions`

Cuerpo: `{ merchants: string[] }` (hasta 200). Respuesta:
`{ suggestions: [{ merchant, categoryId | null, uses }] }`.

- Se compara el comercio **normalizado** (minúsculas, espacios recortados y colapsados) con la descripción normalizada de
  los movimientos **propios** del usuario (RLS) de los últimos 12 meses, no borrados, con categoría no archivada. En los
  importados se descarta la nota de moneda.
- Sugiere la categoría más usada para ese comercio; ante empate, la más reciente. `uses` es cuántas veces se usó.
  Sin historial → `categoryId: null`.

### 4. FinSelf web: sección "Dispositivos"

En `web-finseft`, una pantalla (por ejemplo en la cuenta del usuario o en el menú):
- lista los dispositivos con nombre, prefijo, fecha de creación, último uso y estado;
- permite crear un dispositivo nuevo y muestra el token una única vez, con botón "Copiar" y el aviso de que no se
  volverá a mostrar;
- permite revocar, con confirmación.

### 5. OpenAPI, pruebas y despliegue

- **OpenAPI:** nuevo esquema de seguridad para el token de dispositivo. En las cuatro rutas permitidas se documenta que
  aceptan ambos.
- **Pruebas de integración**, que además pasan por la validación de contrato existente:
  - token válido, revocado e inválido;
  - 403 en rutas no permitidas;
  - lote mixto con los cinco estados;
  - posible duplicado: misma tarjeta y monto a ±1 día de uno manual; fuera de rango o con otro monto no se marca;
    `confirmDuplicate` lo crea; movimientos manuales borrados no cuentan;
  - reenvío idempotente;
  - tarjeta ambigua;
  - moneda extranjera;
  - categoría ajena o archivada;
  - período según día de corte;
  - sugerencias.
- **Migración** `002_device_tokens.sql`, aplicada a la Orange Pi siguiendo `deploy/README.md`.

## Lo que necesitará la app (siguiente proyecto, solo como referencia)

- **Red:** permiso `INTERNET` y configuración de seguridad de red que permita HTTP **solo** hacia la IP de la Orange Pi.
- **Configuración:** URL base editable en la app, y el token guardado en almacenamiento cifrado.
- **Flujo:**
  1. Descargar categorías e instrumentos.
  2. Pedir sugerencias para las compras sin categorizar.
  3. El usuario confirma o elige.
  4. "Enviar" manda el lote.
  5. Marcar como enviadas las `created`/`exists`/`discarded`, mostrar las `rejected` con su motivo y, para cada
     `possible_duplicate`, mostrar el movimiento parecido y preguntar "¿es el mismo?" (sí → resolver sin enviar;
     no → reenviar con `confirmDuplicate: true`).
- **Usuario:** reservar en el router una IP fija para la Orange Pi.

## A criterio de quien construya

- Formato exacto del token (salvo el prefijo reconocible) y cómo se limita la actualización de `last_used_at`.
- Detalle de la normalización de comercios, si se mantiene la regla descrita.
- Ubicación y diseño visual de la pantalla "Dispositivos", con el estilo existente del front.
- Nombres internos de módulos y archivos.

## Decisiones que tomé yo (revisables)

- Lote máximo de 200; `categoryId` obligatorio; descripción sin comuna ni país.
- Ante `last4` repetidos se prefiere la tarjeta de crédito.
- Un movimiento importado y luego borrado en FinSelf se informa como `discarded` y no se recrea.
- La regla de moneda extranjera (`round` a la unidad mayor, mínimo $1).
- Sugerencia = categoría más usada en 12 meses para el comercio normalizado.
- Un elemento malformado vuelve como `rejected` / `invalid_item` sin romper el lote; los resultados llevan `index`.
- Montos en otra moneda: el contrato es "centésimas", como los envía la app hoy (sin tabla de decimales por moneda).
- Posible duplicado: solo contra movimientos `manual`, mismo monto exacto, ±1 día; varias compras pueden apuntar al
  mismo movimiento manual (cada una se decide por separado).
