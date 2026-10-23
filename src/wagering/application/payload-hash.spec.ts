import { describe, expect, test } from 'bun:test';
import { canonicalJson, hashPayload } from './payload-hash';

describe('canonicalJson', () => {
  test('ordena as chaves em qualquer nível', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('omite valores undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('hashPayload', () => {
  test('a ordem das chaves não muda o hash', () => {
    const a = hashPayload({ kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
    const b = hashPayload({ money: { currency: 'BRL', amount: '25.00' }, kind: 'BET' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('valor diferente gera hash diferente', () => {
    const a = hashPayload({ money: { amount: '25.00', currency: 'BRL' } });
    const b = hashPayload({ money: { amount: '25.01', currency: 'BRL' } });
    expect(a).not.toBe(b);
  });

  test('campo opcional ausente equivale a undefined', () => {
    expect(hashPayload({ a: 1 })).toBe(hashPayload({ a: 1, ref: undefined }));
  });
});
