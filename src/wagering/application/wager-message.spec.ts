import { describe, expect, test } from 'bun:test';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { MessageFormatError, parseWagerTransactionRequested } from './wager-message';

function body(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-23T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...dataOverrides,
    },
    ...overrides,
  });
}

describe('parseWagerTransactionRequested', () => {
  test('traduz a mensagem no comando do caso de uso', () => {
    const parsed = parseWagerTransactionRequested(body());
    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.command.idempotencyKey).toBe('provider-a:ext-1');
    expect(parsed.command.kind).toBe(WagerTransactionKind.Bet);
    expect(parsed.command.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(parsed.command.correlationId).toBe('msg-1');
  });

  test('o hash ignora messageId e occurredAt, mas muda com o conteúdo', () => {
    const a = parseWagerTransactionRequested(body());
    const b = parseWagerTransactionRequested(body({ messageId: 'msg-2', occurredAt: '2030-01-01T00:00:00.000Z' }));
    const c = parseWagerTransactionRequested(body({}, { money: { amount: '30.00', currency: 'BRL' } }));
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.payloadHash).not.toBe(c.payloadHash);
  });

  test.each([
    ['JSON inválido', 'isto não é json'],
    ['sem messageId', body({ messageId: undefined })],
    ['tipo desconhecido', body({ type: 'Outra' })],
    ['sem data', body({ data: undefined })],
    ['kind desconhecido', body({}, { kind: 'APOSTA' })],
    ['amount como number', body({}, { money: { amount: 25, currency: 'BRL' } })],
    ['sem idempotencyKey', body({}, { idempotencyKey: undefined })],
  ])('rejeita: %s', (_name, input) => {
    expect(() => parseWagerTransactionRequested(input)).toThrow(MessageFormatError);
  });
});
