// Valida respuestas reales contra el OpenAPI: cada llamada de las pruebas de integración pasa por aquí.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildOpenApi } from '../src/openapi/document.ts';

type Json = any;
export const spec: Json = buildOpenApi();

// ajv y ajv-formats son CommonJS: según el cargador el export viene en `.default` o directo.
const Ajv: any = (Ajv2020 as any).default ?? Ajv2020;
const ajv = new Ajv({ strict: false, allErrors: true });
((addFormats as any).default ?? addFormats)(ajv);

interface Template {
  path: string;
  regex: RegExp;
  params: number;
}
const templates: Template[] = Object.keys(spec.paths)
  .map((path) => ({ path, params: (path.match(/\{/g) ?? []).length, regex: new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$') }))
  .sort((a, b) => a.params - b.params); // las rutas fijas antes que las parametrizadas

const resolve = (r: Json): Json => (r?.$ref ? spec.components.responses[r.$ref.split('/').pop()!] : r);
const validators = new Map<string, any>();

/** Devuelve un texto con el problema, o null si la respuesta cumple el contrato. */
export function checkContract(method: string, pathWithQuery: string, status: number, body: unknown): string | null {
  const path = pathWithQuery.split('?')[0]!;
  const m = method.toLowerCase();
  const t = templates.find((x) => x.regex.test(path) && spec.paths[x.path][m]);
  if (!t) return `${method} ${path}: el endpoint no está documentado en el OpenAPI`;
  const operation = spec.paths[t.path][m];
  const response = resolve(operation.responses[String(status)]);
  if (!response) return `${method} ${t.path}: el status ${status} no está documentado (documentados: ${Object.keys(operation.responses).join(', ')})`;

  const schema = response.content?.['application/json']?.schema;
  if (!schema) return body === null || body === undefined ? null : `${method} ${t.path} ${status}: se documentó sin cuerpo pero devolvió uno`;
  if (body === null || body === undefined) return `${method} ${t.path} ${status}: se documentó con cuerpo pero llegó vacío`;

  const key = `${m} ${t.path} ${status}`;
  let validate = validators.get(key);
  if (!validate) {
    // Los $ref ('#/components/...') se resuelven dentro del mismo documento: se compila junto con `components`.
    validate = ajv.compile({ ...schema, components: spec.components });
    validators.set(key, validate);
  }
  if (validate(body)) return null;
  const detail = ((validate.errors ?? []) as any[]).slice(0, 6).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && 'additionalProperty' in e.params ? ` (${e.params.additionalProperty})` : ''}`);
  return `${method} ${t.path} ${status}: la respuesta no cumple el esquema:\n  - ${detail.join('\n  - ')}`;
}
