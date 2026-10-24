import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, InvalidCursorError } from './ledger-cursor';

describe('cursor do ledger', () => {
  test('ida e volta preserva o seq', () => {
    expect(decodeCursor(encodeCursor('12345'))).toBe('12345');
  });

  test('é opaco: não deixa o seq à mostra', () => {
    expect(encodeCursor('12345')).not.toContain('12345');
  });

  test.each([
    ['lixo', 'isto-nao-e-um-cursor'],
    ['vazio', ''],
    ['JSON sem campos', Buffer.from('{}').toString('base64url')],
    ['versão desconhecida', Buffer.from(JSON.stringify({ v: 2, seq: '5' })).toString('base64url')],
    ['seq como número', Buffer.from(JSON.stringify({ v: 1, seq: 5 })).toString('base64url')],
    ['seq zero', Buffer.from(JSON.stringify({ v: 1, seq: '0' })).toString('base64url')],
    ['seq negativo', Buffer.from(JSON.stringify({ v: 1, seq: '-3' })).toString('base64url')],
    ['seq enorme', Buffer.from(JSON.stringify({ v: 1, seq: '9'.repeat(25) })).toString('base64url')],
    ['seq com texto', Buffer.from(JSON.stringify({ v: 1, seq: '1; drop table' })).toString('base64url')],
  ])('rejeita: %s', (_name, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});
