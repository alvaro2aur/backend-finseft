import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, test } from 'bun:test';
import { mounts } from '../src/routes/index.ts';
import { spec } from './contract.ts';
import { api } from './helpers.ts';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Endpoints reales: recorre los routers montados (Express) y los pasa a la notación de OpenAPI. */
function realEndpoints(): string[] {
  const out: string[] = [];
  for (const [prefix, router] of mounts) {
    for (const layer of (router as any).stack) {
      if (!layer.route) continue;
      const path = (prefix + (layer.route.path === '/' ? '' : layer.route.path)).replace(/:([A-Za-z]+)/g, '{$1}') || '/';
      for (const m of Object.keys(layer.route.methods)) out.push(`${m} ${path}`);
    }
  }
  return out.sort();
}

function documentedEndpoints(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const m of METHODS) if (item[m]) out.push(`${m} ${path}`);
  return out.sort();
}

describe('OpenAPI', () => {
  test('es un documento OpenAPI 3.1 válido', async () => {
    const res = await new Validator().validate(structuredClone(spec));
    expect(res.errors ?? null).toBeNull();
    expect(res.valid).toBe(true);
  });

  test('documenta exactamente los endpoints que existen', () => {
    const real = realEndpoints();
    const doc = documentedEndpoints();
    expect(real.filter((e) => !doc.includes(e))).toEqual([]); // existen pero no están documentados
    expect(doc.filter((e) => !real.includes(e))).toEqual([]); // están documentados pero no existen
    expect(real.length).toBeGreaterThan(30);
  });

  test('cada operación tiene operationId único, resumen y etiqueta', () => {
    const ids: string[] = [];
    for (const item of Object.values<any>(spec.paths))
      for (const m of METHODS)
        if (item[m]) {
          ids.push(item[m].operationId);
          expect(item[m].summary).toBeString();
          expect(item[m].tags?.length).toBeGreaterThan(0);
        }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('las operaciones protegidas documentan 401 y las que reciben cuerpo, 400', () => {
    for (const [path, item] of Object.entries<any>(spec.paths))
      for (const m of METHODS) {
        const op = item[m];
        if (!op) continue;
        if (op.security?.length) expect(op.responses['401'], `${m} ${path} sin 401`).toBeDefined();
        if (op.requestBody) expect(op.responses['400'], `${m} ${path} sin 400`).toBeDefined();
      }
  });

  test('los cuerpos de request vienen de los esquemas de validación', () => {
    const reg = spec.components.schemas.RegisterRequest;
    expect(reg.required).toEqual(['email', 'password']);
    expect(reg.properties.password.minLength).toBe(8);
    expect(reg.properties.email.format).toBe('email');
    // Los defaults dejan el campo opcional al enviarlo
    expect(spec.components.schemas.CreateCategoryRequest.required).toEqual(['name']);
    expect(spec.components.schemas.UpdateCategoryRequest.additionalProperties).toBe(false);
    expect(spec.components.schemas.CreateInstrumentRequest.properties.last4.pattern).toBe('^\\d{4}$');
  });

  test('las requests no declaran `default` (los generadores de tipos los volverían obligatorios)', () => {
    expect(JSON.stringify(spec.components.schemas.CreateCategoryRequest)).not.toContain('"default"');
    expect(spec.components.schemas.CreateCategoryRequest.properties.kind.description).toContain('Por defecto: `"variable"`');
  });

  test('GET /openapi.json sirve el mismo documento', async () => {
    const r = await api('GET', '/openapi.json');
    expect(r.status).toBe(200);
    expect(r.json).toEqual(JSON.parse(JSON.stringify(spec)));
  });

  test('openapi.json del repositorio está al día (bun run openapi:export)', () => {
    const committed = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(spec)));
  });
});
