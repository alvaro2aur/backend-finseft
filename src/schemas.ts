// Esquemas de entrada de la API: los usan las rutas para validar y el documento OpenAPI para
// describir los cuerpos de las requests (src/openapi/), así validación y documentación no se separan.
import { z } from 'zod';
import { isoDate, uuid } from './lib/validate.ts';

export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(200);

export const categoryKind = z.enum(['fija', 'variable']);
export const categoryScope = z.enum(['personal', 'shared']);
export const instrumentType = z.enum(['cuenta_corriente', 'tarjeta_debito', 'tarjeta_credito']);
export const txnType = z.enum(['ingreso', 'egreso']);
export const householdRole = z.enum(['owner', 'member']);

const money = z.number().int().max(1_000_000_000_000);
const name = z.string().trim().min(1).max(100);
const currency = z.string().length(3).toUpperCase();

// --- Autenticación ---
export const registerBody = z.object({ email, password, displayName: z.string().trim().min(1).max(100).optional() });
export const loginBody = z.object({ email, password: z.string().min(1).max(200) });
export const googleBody = z.object({ idToken: z.string().min(10) });
export const refreshBody = z.object({ refreshToken: z.string().min(10) });
export const forgotPasswordBody = z.object({ email });
export const resetPasswordBody = z.object({ token: z.string().min(10), password });
export const patchMeBody = z
  .object({ displayName: z.string().trim().min(1).max(100).nullable().optional(), currency: currency.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar');

// --- Grupo ---
export const patchHouseholdBody = z.object({ name });
export const patchMemberBody = z.object({ role: householdRole });
export const inviteBody = z.object({ email, role: householdRole.default('member') });
export const acceptInvitationBody = z.object({ token: z.string().min(10) });

// --- Categorías ---
const budget = money.min(0);
export const createCategoryBody = z.object({
  name,
  kind: categoryKind.default('variable'),
  budget: budget.default(0),
  scope: categoryScope.default('personal'),
});
export const patchCategoryBody = z
  .object({ name: name.optional(), kind: categoryKind.optional(), budget: budget.optional(), archived: z.boolean().optional() })
  .strict();

// --- Instrumentos ---
const bank = z.string().trim().min(1).max(100);
const last4 = z.string().regex(/^\d{4}$/, 'Deben ser exactamente 4 dígitos');
const label = z.string().trim().min(1).max(100);
export const createInstrumentBody = z.object({ type: instrumentType, bank, last4, label: label.nullable().optional() });
export const patchInstrumentBody = z
  .object({ type: instrumentType.optional(), bank: bank.optional(), last4: last4.optional(), label: label.nullable().optional(), archived: z.boolean().optional() })
  .strict();

// --- Movimientos ---
export const createTransactionBody = z.object({
  date: isoDate,
  type: txnType,
  amount: money.min(1),
  description: z.string().trim().min(1).max(200),
  instrumentId: uuid,
  categoryId: uuid.nullable().optional(),
  currency: currency.optional(),
});
export const patchTransactionBody = createTransactionBody.partial().strict();
