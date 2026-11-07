import { describe, expect, test } from 'bun:test';
import { importDescription, localDate, toClpAmount } from '../src/lib/importRules.ts';

describe('reglas de importación', () => {
  test('montos: CLP tal cual; otras monedas en centésimas a pesos, mínimo 1', () => {
    expect(toClpAmount(42380, 'CLP')).toBe(42380);
    expect(toClpAmount(1234, 'USD')).toBe(12);
    expect(toClpAmount(40, 'USD')).toBe(1);
  });

  test('descripción: el comercio; sin comercio, la tarjeta; otra moneda, con nota', () => {
    expect(importDescription('LIDER EXPRESS', '4082', 42380, 'CLP')).toBe('LIDER EXPRESS');
    expect(importDescription('  ', '4082', 1, 'CLP')).toBe('Compra con tarjeta ····4082');
    expect(importDescription(undefined, '4082', 1, 'CLP')).toBe('Compra con tarjeta ····4082');
    expect(importDescription('AMAZON', '4082', 1234, 'USD')).toBe('AMAZON · USD 12,34 (monto original, ajustar a pesos)');
  });

  test('la fecha es la de Chile, no la de UTC', () => {
    expect(localDate('2026-11-03T02:30:00Z', 'America/Santiago')).toBe('2026-11-02'); // 23:30 del día 2 en Chile
    expect(localDate('2026-11-03T12:00:00-03:00', 'America/Santiago')).toBe('2026-11-03');
  });
});
