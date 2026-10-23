import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../shared/domain/domain-error';
import { ProcessWagerTransactionResult } from './process-wager-transaction.use-case';
import { TransactionProcessor, WagerMessageHandler } from './wager-message-handler';

class SomeDomainError extends DomainError {
  readonly code = 'SOME_DOMAIN_ERROR';
}

const message = JSON.stringify({
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
  },
});

const result: ProcessWagerTransactionResult = {
  transactionId: 't-1',
  status: 'PROCESSED' as ProcessWagerTransactionResult['status'],
  balance: { amount: '75.00', currency: 'BRL' },
  idempotentReplay: false,
};

function handlerWith(execute: TransactionProcessor['execute']): WagerMessageHandler {
  return new WagerMessageHandler({ execute });
}

describe('WagerMessageHandler: classificação do resultado', () => {
  test('resultado registrado vira done, repassando o contexto do inbox', async () => {
    let received: unknown;
    const handler = handlerWith(async (_command, options) => {
      received = options;
      return result;
    });
    expect(await handler.handle(message)).toEqual({
      kind: 'done',
      status: 'PROCESSED',
      replay: false,
      transactionId: 't-1',
    });
    expect(received).toMatchObject({ inbox: { messageId: 'msg-1' } });
  });

  test('mensagem malformada é permanente e não chama o caso de uso', async () => {
    let called = false;
    const handler = handlerWith(async () => {
      called = true;
      return result;
    });
    const outcome = await handler.handle('isto não é json');
    expect(outcome).toMatchObject({ kind: 'permanent', code: 'INVALID_MESSAGE' });
    expect(called).toBe(false);
  });

  test('erro de domínio é permanente (vai para a DLQ)', async () => {
    const handler = handlerWith(async () => {
      throw new SomeDomainError('carteira inexistente');
    });
    expect(await handler.handle(message)).toEqual({
      kind: 'permanent',
      code: 'SOME_DOMAIN_ERROR',
      reason: 'carteira inexistente',
    });
  });

  test('qualquer outro erro é transitório (retry com backoff)', async () => {
    const handler = handlerWith(async () => {
      throw new Error('connection refused');
    });
    expect(await handler.handle(message)).toEqual({ kind: 'transient', reason: 'connection refused' });
  });
});
