// Documento OpenAPI 3.1 de la API.
//  - Cuerpos de request: se derivan de los esquemas zod de src/schemas.ts (la misma validación que usan las rutas).
//  - Respuestas: se describen aquí; las pruebas de integración validan cada respuesta real contra estos
//    esquemas (test/contract.ts), así que un campo que cambia en la API y no aquí rompe las pruebas.
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import * as S from '../schemas.ts';

type Json = Record<string, unknown>;

// --- Constructores de JSON Schema ---
const str = (extra: Json = {}): Json => ({ type: 'string', ...extra });
const int = (extra: Json = {}): Json => ({ type: 'integer', ...extra });
const num = (extra: Json = {}): Json => ({ type: 'number', ...extra });
const bool = (): Json => ({ type: 'boolean' });
const uuid = (): Json => str({ format: 'uuid' });
const dateTime = (): Json => str({ format: 'date-time' });
const date = (): Json => str({ format: 'date', description: 'YYYY-MM-DD' });
const arr = (items: Json): Json => ({ type: 'array', items });
const nullable = (s: Json): Json => ({ anyOf: [s, { type: 'null' }] });
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const oneOfEnum = (...values: string[]): Json => str({ enum: values });
/** Objeto cerrado: un campo no documentado hace fallar la validación del contrato. */
const obj = (properties: Record<string, Json>, required: string[] = Object.keys(properties)): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const role = oneOfEnum('owner', 'member');
const kind = oneOfEnum('fija', 'variable');
const scope = oneOfEnum('personal', 'shared');
const txnType = oneOfEnum('ingreso', 'egreso');
const instrumentType = oneOfEnum('cuenta_corriente', 'tarjeta_debito', 'tarjeta_credito');
const money = (description?: string): Json => int(description ? { description } : {});

// --- Componentes ---
const vsPrevious = obj({
  previous: money('Total del mes anterior completo'),
  amount: money('Mes actual menos mes anterior'),
  pct: nullable(num({ description: 'Variación porcentual con un decimal; null si el mes anterior fue 0' })),
});

const budgetTotals = {
  budget: money('Suma de presupuestos'),
  spent: money(),
  usedPct: nullable(int({ description: 'null si no hay presupuesto' })),
  available: money('budget − spent; negativo si se excedió'),
  perDayAllowed: nullable(money('Disponible entre los días que quedan después de hoy; null en meses cerrados o sin días restantes')),
};
const monthMeta = {
  month: str({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }),
  daysInMonth: int(),
  daysElapsed: int({ description: 'Días transcurridos incluyendo hoy; 0 en meses futuros' }),
  currency: str({ description: 'Moneda base del usuario; los resúmenes solo consideran movimientos en esta moneda' }),
};

const schemas: Record<string, Json> = {
  Error: obj({ error: obj({ code: str(), message: str(), details: {} }, ['code', 'message']) }),

  User: obj({ id: uuid(), email: str({ format: 'email' }), displayName: nullable(str()), currency: str(), householdId: uuid(), householdRole: role }),
  AuthResponse: obj({ user: ref('User'), accessToken: str(), refreshToken: str(), expiresIn: int({ description: 'Segundos de vida del access token' }) }),

  Member: obj({ id: uuid(), email: str({ format: 'email' }), displayName: nullable(str()), role }),
  Household: obj({ id: uuid(), name: str(), myRole: role, members: arr(ref('Member')) }),
  HouseholdName: obj({ id: uuid(), name: str() }),
  Invitation: obj({ id: uuid(), email: str({ format: 'email' }), role, expiresAt: dateTime(), createdAt: dateTime() }),
  InvitationList: obj({ items: arr(ref('Invitation')) }),
  HouseholdMembership: obj({ householdId: uuid(), role }),

  Category: obj({
    id: uuid(),
    name: str(),
    kind,
    scope,
    budget: int({ minimum: 0, description: '0 = sin límite' }),
    archived: bool(),
    createdAt: dateTime(),
    updatedAt: dateTime(),
  }),
  CategoryList: obj({ items: arr(ref('Category')) }),

  Instrument: obj({ id: uuid(), type: instrumentType, bank: str(), last4: str({ pattern: '^\\d{4}$' }), label: nullable(str()), billingCutDay: nullable(int({ minimum: 1, maximum: 31, description: 'Día de corte de la facturación (solo tarjetas de crédito); null = mes calendario' })), archived: bool(), createdAt: dateTime(), updatedAt: dateTime() }),
  InstrumentList: obj({ items: arr(ref('Instrument')) }),
  InstrumentSummary: obj({ id: uuid(), type: instrumentType, bank: str(), last4: str({ pattern: '^\\d{4}$' }) }),

  Transaction: obj({
    id: uuid(),
    date: date(),
    budgetMonth: str({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'Mes al que se imputa: el calendario de `date`, o el período de facturación si la tarjeta tiene día de corte' }),
    type: txnType,
    amount: int({ minimum: 1, description: 'Siempre positivo; el signo lo da `type`' }),
    currency: str(),
    description: str(),
    categoryId: nullable(uuid()),
    categoryName: nullable(str()),
    categoryScope: nullable(scope),
    instrumentId: uuid(),
    instrument: ref('InstrumentSummary'),
    source: str({ description: 'manual | telegram | import' }),
    createdAt: dateTime(),
    updatedAt: dateTime(),
  }),
  TransactionList: obj({
    items: arr(ref('Transaction')),
    page: int(),
    pageSize: int(),
    total: int({ description: 'Movimientos que cumplen el filtro (todas las páginas)' }),
    totals: obj({ income: money(), expense: money(), balance: money() }),
  }),

  CategoryLine: obj({
    id: uuid(),
    name: str(),
    kind,
    scope,
    archived: bool(),
    budget: int(),
    spent: money('En categorías compartidas es el gasto de todo el grupo'),
    mySpent: money('Parte del usuario que consulta'),
    pct: nullable(int()),
    over: bool(),
    left: nullable(money()),
  }),
  PersonalSummary: obj({
    ...monthMeta,
    totals: obj({
      ...budgetTotals,
      income: money(),
      expense: money('Todo lo propio: categorías personales, su parte en compartidas y sin categoría'),
      savings: money(),
      savingsPct: nullable(int()),
      dailyAverage: money(),
      dailyAverageWithoutFixed: money(),
      vsPreviousMonth: ref('VsPrevious'),
    }),
    categories: arr(ref('CategoryLine')),
    sharedContribution: arr(obj({ id: uuid(), name: str(), kind, mySpent: money() })),
    uncategorized: obj({ mySpent: money() }),
    recent: arr(ref('Transaction')),
  }),
  HouseholdSummary: obj({
    ...monthMeta,
    memberCount: int(),
    totals: obj({ ...budgetTotals, mySpent: money(), dailyAverage: money(), dailyAverageWithoutFixed: money(), vsPreviousMonth: ref('VsPrevious') }),
    categories: arr(ref('CategoryLine')),
  }),
  VsPrevious: vsPrevious,
  Health: obj({ status: oneOfEnum('ok') }),
  Device: obj({ id: uuid(), name: str(), prefix: str({ description: 'Primeros caracteres del token, para reconocerlo' }), createdAt: dateTime(), lastUsedAt: nullable(dateTime()), revoked: bool() }),
  DeviceList: obj({ items: arr(ref('Device')) }),
  CreatedDevice: obj({ id: uuid(), name: str(), prefix: str(), createdAt: dateTime(), lastUsedAt: nullable(dateTime()), revoked: bool(), token: str({ description: 'Se muestra solo en esta respuesta; guárdalo en la app' }) }),
  CurrentPeriod: obj({ month: str({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }) }),
};

// Cuerpos de request: derivados de zod. `io: 'input'` describe lo que se envía (los defaults quedan opcionales).
const bodies = {
  CreateDeviceRequest: S.createDeviceBody,
  RegisterRequest: S.registerBody,
  LoginRequest: S.loginBody,
  GoogleLoginRequest: S.googleBody,
  RefreshRequest: S.refreshBody,
  ForgotPasswordRequest: S.forgotPasswordBody,
  ResetPasswordRequest: S.resetPasswordBody,
  UpdateMeRequest: S.patchMeBody,
  UpdateHouseholdRequest: S.patchHouseholdBody,
  UpdateMemberRequest: S.patchMemberBody,
  InviteRequest: S.inviteBody,
  AcceptInvitationRequest: S.acceptInvitationBody,
  CreateCategoryRequest: S.createCategoryBody,
  UpdateCategoryRequest: S.patchCategoryBody,
  CreateInstrumentRequest: S.createInstrumentBody,
  UpdateInstrumentRequest: S.patchInstrumentBody,
  CreateTransactionRequest: S.createTransactionBody,
  UpdateTransactionRequest: S.patchTransactionBody,
} as const;

/**
 * Los generadores de tipos (openapi-typescript) tratan un campo con `default` como obligatorio, lo que
 * en una request es falso: el servidor lo completa. Se pasa el default a la descripción.
 */
function defaultsToDescription(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(defaultsToDescription);
  if (!node || typeof node !== 'object') return;
  const n = node as Json;
  if ('default' in n) {
    const note = `Por defecto: \`${JSON.stringify(n.default)}\``;
    n.description = n.description ? `${n.description}. ${note}` : note;
    delete n.default;
  }
  Object.values(n).forEach(defaultsToDescription);
}

function bodySchema(schema: z.ZodType): Json {
  const { $schema: _omit, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  defaultsToDescription(json);
  return json;
}

// --- Respuestas de error reutilizables ---
const errorResponses = {
  BadRequest: [400, 'Datos inválidos (`validation_error`, `invalid_json`, `invalid_value`) o token de un solo uso inválido (`invalid_token`)'],
  Unauthorized: [401, 'Falta el access token, es inválido o expiró (`unauthorized`, `invalid_token`); o credenciales incorrectas (`invalid_credentials`)'],
  Forbidden: [403, 'Sin permiso para la operación (`forbidden`, `wrong_account`)'],
  NotFound: [404, 'No existe — también cuando pertenece a otro usuario (`not_found`)'],
  Conflict: [409, 'Duplicado o regla de grupo (`conflict`, `email_taken`, `already_member`, `last_owner`, `alone_in_household`)'],
  Unprocessable: [422, 'Referencia inválida: categoría o instrumento inexistente o ajeno (`invalid_reference`)'],
} as const;
type ErrorName = keyof typeof errorResponses;

const responses: Record<string, Json> = Object.fromEntries(
  Object.entries(errorResponses).map(([name, [, description]]) => [name, { description, content: { 'application/json': { schema: ref('Error') } } }]),
);

// --- Operaciones ---
const jsonOf = (schema: Json): Json => ({ 'application/json': { schema } });
const idParam: Json = { name: 'id', in: 'path', required: true, schema: uuid() };
const query = (name: string, schema: Json, description: string): Json => ({ name, in: 'query', required: false, schema, description });
const monthParam = query('month', str({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }), 'Mes de presupuesto `YYYY-MM` (en tarjetas con día de corte, su período de facturación); por defecto el mes calendario actual. Ver `GET /periods/current`');
const includeArchived = query('includeArchived', oneOfEnum('true', 'false', '1', '0'), 'Incluir archivados (por defecto no)');

interface Op {
  tag: string;
  id: string;
  summary: string;
  description?: string;
  auth?: boolean; // por defecto true
  params?: Json[];
  body?: keyof typeof bodies;
  ok: [number, string, Json | null]; // [status, descripción, esquema o null (sin cuerpo)]
  errors?: ErrorName[];
  extra?: Record<number, Json>; // respuestas adicionales que no son de la lista común
  device?: boolean; // también acepta token de dispositivo (app)
}

function op(o: Op): Json {
  const errors: ErrorName[] = [...(o.errors ?? [])];
  if (o.auth !== false && !errors.includes('Unauthorized')) errors.push('Unauthorized');
  // Un token de dispositivo puede llegar a cualquier operación protegida y recibir 403.
  if (o.auth !== false && !errors.includes('Forbidden')) errors.push('Forbidden');
  if (o.body && !errors.includes('BadRequest')) errors.unshift('BadRequest');
  const [status, description, schema] = o.ok;
  return {
    tags: [o.tag],
    operationId: o.id,
    summary: o.summary,
    ...(o.description ? { description: o.description } : {}),
    security: o.auth === false ? [] : o.device ? [{ bearerAuth: [] }, { deviceToken: [] }] : [{ bearerAuth: [] }],
    ...(o.params?.length ? { parameters: o.params } : {}),
    ...(o.body ? { requestBody: { required: true, content: jsonOf(ref(o.body)) } } : {}),
    responses: {
      [status]: { description, ...(schema ? { content: jsonOf(schema) } : {}) },
      ...Object.fromEntries(errors.map((e) => [errorResponses[e][0], { $ref: `#/components/responses/${e}` }])),
      ...(o.extra ?? {}),
    },
  };
}

const rateLimited: Record<number, Json> = {
  429: { description: 'Demasiados intentos desde esta IP (30 por minuto en `/auth/*`); el cuerpo es texto plano, no el formato de error común' },
};
const sessionOk: Op['ok'] = [200, 'Sesión iniciada', ref('AuthResponse')];
const noContent = (description: string): Op['ok'] => [204, description, null];

const paths: Record<string, Json> = {
  '/health': {
    get: op({ tag: 'Sistema', id: 'health', summary: 'Estado del servicio', auth: false, ok: [200, 'El servicio y la base de datos responden', ref('Health')] }),
  },
  '/openapi.json': {
    get: op({ tag: 'Sistema', id: 'getOpenApi', summary: 'Este documento', auth: false, ok: [200, 'Documento OpenAPI 3.1', { type: 'object' }] }),
  },

  // --- Autenticación ---
  '/auth/register': {
    post: op({ tag: 'Autenticación', id: 'register', summary: 'Crear cuenta', description: 'Crea el usuario y su grupo propio (queda como `owner`). El correo no distingue mayúsculas.', auth: false, body: 'RegisterRequest', ok: [201, 'Cuenta creada', ref('AuthResponse')], errors: ['Conflict'] }),
  },
  '/auth/login': {
    post: op({ tag: 'Autenticación', id: 'login', summary: 'Iniciar sesión con correo y contraseña', auth: false, body: 'LoginRequest', ok: sessionOk, errors: ['Unauthorized'] }),
  },
  '/auth/google': {
    post: op({ tag: 'Autenticación', id: 'loginWithGoogle', summary: 'Iniciar sesión con Google', description: 'Recibe el ID token de Google Identity Services. Si el correo ya existe, vincula la identidad. Responde 501 si el servidor no tiene `GOOGLE_CLIENT_ID`.', auth: false, body: 'GoogleLoginRequest', ok: sessionOk, errors: ['Unauthorized'], extra: { 501: { description: 'El servidor no tiene configurado `GOOGLE_CLIENT_ID` (`google_not_configured`)', content: jsonOf(ref('Error')) } } }),
  },
  '/auth/refresh': {
    post: op({ tag: 'Autenticación', id: 'refresh', summary: 'Renovar la sesión', description: 'Rota el refresh token: el anterior deja de servir. Si se reutiliza uno ya rotado se asume robo y se cierra toda la familia de sesiones.', auth: false, body: 'RefreshRequest', ok: sessionOk, errors: ['Unauthorized'] }),
  },
  '/auth/logout': {
    post: op({ tag: 'Autenticación', id: 'logout', summary: 'Cerrar sesión', description: 'Revoca la familia de refresh tokens. Siempre 204, exista o no el token.', auth: false, body: 'RefreshRequest', ok: noContent('Sesión cerrada') }),
  },
  '/auth/forgot-password': {
    post: op({ tag: 'Autenticación', id: 'forgotPassword', summary: 'Pedir enlace para recuperar la contraseña', description: 'Siempre 204, exista o no la cuenta, para no revelar qué correos están registrados.', auth: false, body: 'ForgotPasswordRequest', ok: noContent('Solicitud recibida') }),
  },
  '/auth/reset-password': {
    post: op({ tag: 'Autenticación', id: 'resetPassword', summary: 'Elegir una contraseña nueva', description: 'El token es de un solo uso. Cierra todas las sesiones abiertas de la cuenta.', auth: false, body: 'ResetPasswordRequest', ok: noContent('Contraseña actualizada') }),
  },

  // --- Cuenta ---
  '/me': {
    get: op({ tag: 'Cuenta', id: 'getMe', summary: 'Usuario autenticado', ok: [200, 'Usuario', ref('User')] }),
    patch: op({ tag: 'Cuenta', id: 'updateMe', summary: 'Actualizar nombre o moneda base', body: 'UpdateMeRequest', ok: [200, 'Usuario actualizado', ref('User')] }),
  },

  // --- Grupo ---
  '/household': {
    get: op({ tag: 'Grupo', id: 'getHousehold', summary: 'Grupo familiar y sus miembros', ok: [200, 'Grupo', ref('Household')] }),
    patch: op({ tag: 'Grupo', id: 'updateHousehold', summary: 'Renombrar el grupo', description: 'Solo owners.', body: 'UpdateHouseholdRequest', ok: [200, 'Grupo actualizado', ref('HouseholdName')], errors: ['Forbidden'] }),
  },
  '/household/members/{id}': {
    patch: op({ tag: 'Grupo', id: 'updateMemberRole', summary: 'Cambiar el rol de un miembro', description: 'Solo owners. Siempre debe quedar al menos un owner.', params: [idParam], body: 'UpdateMemberRequest', ok: [200, 'Miembro actualizado', ref('Member')], errors: ['Forbidden', 'NotFound', 'Conflict'] }),
  },
  '/household/invitations': {
    get: op({ tag: 'Grupo', id: 'listInvitations', summary: 'Invitaciones pendientes', description: 'Solo owners.', ok: [200, 'Invitaciones vigentes', ref('InvitationList')], errors: ['Forbidden'] }),
    post: op({ tag: 'Grupo', id: 'createInvitation', summary: 'Invitar a alguien al grupo', description: 'Solo owners. Envía un enlace por correo (vence en 7 días). El token no se devuelve.', body: 'InviteRequest', ok: [201, 'Invitación creada', ref('Invitation')], errors: ['Forbidden', 'Conflict'] }),
  },
  '/household/invitations/{id}': {
    delete: op({ tag: 'Grupo', id: 'deleteInvitation', summary: 'Cancelar una invitación pendiente', description: 'Solo owners.', params: [idParam], ok: noContent('Invitación cancelada'), errors: ['Forbidden', 'NotFound'] }),
  },
  '/household/invitations/accept': {
    post: op({
      tag: 'Grupo',
      id: 'acceptInvitation',
      summary: 'Aceptar una invitación',
      description:
        'Mueve al usuario al grupo que lo invitó. El correo de la cuenta debe coincidir con el de la invitación. Sus instrumentos, movimientos y categorías personales lo siguen; los movimientos en categorías compartidas del grupo anterior quedan sin categoría, y si ese grupo queda vacío se elimina.',
      body: 'AcceptInvitationRequest',
      ok: [200, 'Usuario movido al nuevo grupo', ref('HouseholdMembership')],
      errors: ['Forbidden', 'Conflict'],
    }),
  },
  '/household/leave': {
    post: op({ tag: 'Grupo', id: 'leaveHousehold', summary: 'Dejar el grupo', description: 'Pasa al usuario a un grupo nuevo propio. Falla si es el único owner y quedan más miembros, o si ya está solo.', ok: [200, 'Nuevo grupo propio', ref('HouseholdMembership')], errors: ['Conflict'] }),
  },

  // --- Categorías ---
  '/categories': {
    get: op({
      tag: 'Categorías',
      id: 'listCategories',
      summary: 'Categorías visibles',
      description: 'Las compartidas del grupo y las personales del usuario.',
      params: [includeArchived, query('scope', scope, 'Filtra por alcance')],
      device: true,
      ok: [200, 'Categorías', ref('CategoryList')],
      errors: ['BadRequest'],
    }),
    post: op({ tag: 'Categorías', id: 'createCategory', summary: 'Crear categoría', description: 'Las compartidas (`scope: "shared"`) solo las crea un owner. El nombre es único dentro de su alcance, sin distinguir mayúsculas.', body: 'CreateCategoryRequest', ok: [201, 'Categoría creada', ref('Category')], errors: ['Forbidden', 'Conflict'] }),
  },
  '/categories/{id}': {
    patch: op({ tag: 'Categorías', id: 'updateCategory', summary: 'Editar, archivar o restaurar una categoría', description: 'El alcance no se cambia. Editar una compartida requiere ser owner. `archived: true|false` archiva o restaura.', params: [idParam], body: 'UpdateCategoryRequest', ok: [200, 'Categoría actualizada', ref('Category')], errors: ['Forbidden', 'NotFound', 'Conflict'] }),
    delete: op({ tag: 'Categorías', id: 'archiveCategory', summary: 'Archivar una categoría', description: 'No borra: los movimientos conservan su categoría. Una compartida requiere ser owner.', params: [idParam], ok: noContent('Categoría archivada'), errors: ['Forbidden', 'NotFound'] }),
  },

  // --- Instrumentos ---
  '/instruments': {
    get: op({ tag: 'Instrumentos', id: 'listInstruments', summary: 'Instrumentos propios', description: 'Son privados de cada usuario.', params: [includeArchived], ok: [200, 'Instrumentos', ref('InstrumentList')], errors: ['BadRequest'], device: true }),
    post: op({ tag: 'Instrumentos', id: 'createInstrument', summary: 'Crear instrumento', description: 'Nunca se guarda el número completo, solo los últimos 4 dígitos. `billingCutDay` (solo tarjetas de crédito) imputa cada compra al período de facturación: hasta el día de corte, ese mes; desde el día siguiente, el mes siguiente.', body: 'CreateInstrumentRequest', ok: [201, 'Instrumento creado', ref('Instrument')], errors: ['Conflict'] }),
  },
  '/instruments/{id}': {
    patch: op({ tag: 'Instrumentos', id: 'updateInstrument', summary: 'Editar, archivar o restaurar un instrumento', description: 'Cambiar `billingCutDay` reimputa todos los movimientos de la tarjeta. Si deja de ser tarjeta de crédito, pierde el día de corte.', params: [idParam], body: 'UpdateInstrumentRequest', ok: [200, 'Instrumento actualizado', ref('Instrument')], errors: ['NotFound', 'Conflict'] }),
    delete: op({ tag: 'Instrumentos', id: 'archiveInstrument', summary: 'Archivar un instrumento', description: 'No borra: los movimientos conservan su instrumento.', params: [idParam], ok: noContent('Instrumento archivado'), errors: ['NotFound'] }),
  },

  // --- Movimientos ---
  '/transactions': {
    get: op({
      tag: 'Movimientos',
      id: 'listTransactions',
      summary: 'Movimientos propios, filtrados, ordenados y paginados',
      description: 'Son privados de cada usuario. Los totales (`totals`) corresponden a todo el conjunto filtrado, no solo a la página. Sin filtros de fecha devuelve todos los períodos.',
      params: [
        query('month', str({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }), 'Mes de presupuesto `YYYY-MM`: en tarjetas con día de corte es su período de facturación, no la fecha de calendario'),
        query('from', date(), 'Desde (incluido)'),
        query('to', date(), 'Hasta (incluido)'),
        query('categoryId', { anyOf: [uuid(), { const: 'none' }] }, 'Id de categoría, o `none` para movimientos sin categoría'),
        query('q', str({ maxLength: 100 }), 'Texto en la descripción (sin distinguir mayúsculas; `%` y `_` se tratan como texto)'),
        query('type', txnType, 'Ingreso o egreso'),
        query('instrumentId', uuid(), 'Instrumento'),
        query('minAmount', int({ minimum: 0 }), 'Monto mínimo'),
        query('sortBy', oneOfEnum('date', 'category', 'description', 'type', 'instrument', 'amount'), 'Por defecto `date`'),
        query('sortDir', oneOfEnum('asc', 'desc'), 'Por defecto `desc`'),
        query('page', int({ minimum: 1 }), 'Por defecto 1'),
        query('pageSize', int({ minimum: 1, maximum: 100 }), 'Por defecto 20'),
      ],
      ok: [200, 'Página de movimientos', ref('TransactionList')],
      errors: ['BadRequest'],
    }),
    post: op({ tag: 'Movimientos', id: 'createTransaction', summary: 'Registrar un movimiento', description: 'El instrumento debe ser del usuario; la categoría, compartida de su grupo o personal suya.', body: 'CreateTransactionRequest', ok: [201, 'Movimiento creado', ref('Transaction')], errors: ['Unprocessable'] }),
  },
  '/transactions/{id}': {
    get: op({ tag: 'Movimientos', id: 'getTransaction', summary: 'Un movimiento', params: [idParam], ok: [200, 'Movimiento', ref('Transaction')], errors: ['NotFound'] }),
    patch: op({ tag: 'Movimientos', id: 'updateTransaction', summary: 'Editar un movimiento', description: 'Envía solo los campos a cambiar. `categoryId: null` lo deja sin categoría.', params: [idParam], body: 'UpdateTransactionRequest', ok: [200, 'Movimiento actualizado', ref('Transaction')], errors: ['NotFound', 'Unprocessable'] }),
    delete: op({ tag: 'Movimientos', id: 'deleteTransaction', summary: 'Eliminar un movimiento', description: 'Borrado lógico.', params: [idParam], ok: noContent('Movimiento eliminado'), errors: ['NotFound'] }),
  },

  // --- Dispositivos ---
  '/devices': {
    get: op({ tag: 'Dispositivos', id: 'listDevices', summary: 'Tokens de dispositivo del usuario', description: 'Nunca incluye el token, solo su prefijo.', ok: [200, 'Dispositivos', ref('DeviceList')] }),
    post: op({ tag: 'Dispositivos', id: 'createDevice', summary: 'Crear un token de dispositivo', description: 'El token (`fsd_…`) se muestra solo en esta respuesta. Requiere sesión de usuario.', body: 'CreateDeviceRequest', ok: [201, 'Dispositivo creado', ref('CreatedDevice')] }),
  },
  '/devices/{id}': {
    delete: op({ tag: 'Dispositivos', id: 'revokeDevice', summary: 'Revocar un token de dispositivo', description: 'Deja de funcionar de inmediato. No borra el registro.', params: [idParam], ok: noContent('Dispositivo revocado'), errors: ['NotFound'] }),
  },

  // --- Resúmenes ---
  '/periods/current': {
    get: op({
      tag: 'Resúmenes',
      id: 'getCurrentPeriod',
      summary: 'Mes de presupuesto en curso',
      description: 'El mayor entre el mes calendario de hoy y el período actual de cada tarjeta con día de corte (p. ej. el 28 de octubre, con corte el 26, es noviembre). Úsalo como mes por defecto en resúmenes y movimientos.',
      ok: [200, 'Mes en curso', ref('CurrentPeriod')],
    }),
  },
  '/summary/personal': {
    get: op({
      tag: 'Resúmenes',
      id: 'getPersonalSummary',
      summary: 'Resumen personal del mes',
      description:
        'Presupuesto de las categorías **personales** y todo lo propio del usuario (ingresos, ahorro, promedios, comparación con el mes anterior completo, aporte a las compartidas y últimos movimientos). Solo considera la moneda base del usuario.',
      params: [monthParam],
      ok: [200, 'Resumen personal', ref('PersonalSummary')],
      errors: ['BadRequest'],
    }),
  },
  '/summary/household': {
    get: op({
      tag: 'Resúmenes',
      id: 'getHouseholdSummary',
      summary: 'Resumen del grupo del mes',
      description:
        'Solo categorías **compartidas**, con el gasto de todos los miembros. Los movimientos son privados, por lo que se entregan únicamente totales (`spent`) y la parte del usuario (`mySpent`).',
      params: [monthParam],
      ok: [200, 'Resumen del grupo', ref('HouseholdSummary')],
      errors: ['BadRequest'],
    }),
  },
};

// El límite de intentos aplica a todo /auth/*.
for (const [path, item] of Object.entries(paths)) {
  if (!path.startsWith('/auth/')) continue;
  for (const operation of Object.values(item) as { responses: Record<string, Json> }[]) Object.assign(operation.responses, rateLimited);
}

export function buildOpenApi(): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'FinSelf API',
      version: pkg.version,
      description: [
        'API de finanzas personales y familiares.',
        '',
        '**Autenticación.** Envía `Authorization: Bearer <accessToken>` (dura 15 minutos). Renuévalo con `POST /auth/refresh`, que rota el refresh token.',
        '',
        '**Privacidad.** Cada usuario pertenece a un único grupo familiar. Los movimientos e instrumentos son privados de cada usuario; las categorías pueden ser personales o compartidas con el grupo, y del gasto del grupo solo se comparten totales.',
        '',
        '**Convenciones.** Los montos son enteros en la moneda base (pesos) y siempre positivos; el signo lo da `type`. Las fechas son `YYYY-MM-DD` y los meses `YYYY-MM`. Los errores tienen la forma `{ "error": { "code", "message", "details?" } }`.',
      ].join('\n'),
    },
    servers: [{ url: process.env.API_PUBLIC_URL ?? 'http://localhost:3000', description: 'Servidor de la API' }],
    tags: ['Sistema', 'Autenticación', 'Cuenta', 'Grupo', 'Categorías', 'Instrumentos', 'Movimientos', 'Resúmenes', 'Dispositivos'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        deviceToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'fsd_…',
          description: 'Token de dispositivo (app). Solo para GET /categories, GET /instruments, POST /imports/transactions y POST /imports/suggestions.',
        },
      },
      schemas: { ...schemas, ...Object.fromEntries(Object.entries(bodies).map(([name, s]) => [name, bodySchema(s)])) },
      responses,
    },
  };
}
