import { describe, expect, test } from 'bun:test';
import { importDescription, localDate, normalizeMerchant, toClpAmount } from '../src/lib/importRules.ts';

describe('reglas de importación', () => {
  test('montos: CLP tal cual; otras monedas en centésimas a pesos, mínimo 1', () => {
    expect(toClpAmount(42380, 'CLP')).toBe(42380);
    expect(toClpAmount(1234, 'USD')).toBe(12);
    expect(toClpAmount(40, 'USD')).toBe(1);
  });

  test('descripción: la del usuario o null; otra moneda, con la nota del monto original', () => {
    expect(importDescription('Regalo para mamá', 42380, 'CLP')).toBe('Regalo para mamá');
    expect(importDescription(undefined, 1, 'CLP')).toBeNull();
    expect(importDescription('Libro', 1234, 'USD')).toBe('Libro · USD 12,34 (monto original, ajustar a pesos)');
    expect(importDescription(null, 1234, 'USD')).toBe('USD 12,34 (monto original, ajustar a pesos)');
  });

  test('la fecha es la de Chile, no la de UTC', () => {
    expect(localDate('2026-11-03T02:30:00Z', 'America/Santiago')).toBe('2026-11-02'); // 23:30 del día 2 en Chile
    expect(localDate('2026-11-03T12:00:00-03:00', 'America/Santiago')).toBe('2026-11-03');
  });

  test('normalizar comercios: minúsculas, sin espacios sobrantes', () => {
    expect(normalizeMerchant('  Lider   EXPRESS ')).toBe('lider express');
  });
});
