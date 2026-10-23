import { describe, expect, test } from 'bun:test';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { CreateWagerTransactionProps, WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';

const NOW = new Date('2026-10-23T15:00:00.000Z');
const LATER = new Date('2026-10-23T15:00:05.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'r-1',
    gameId: 'g-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
    ...overrides,
  };
}

describe('WagerTransaction.create', () => {
  test('nasce em PENDING', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
  });

  test('OPENING não pode ser submetida, mas existe a factory interna', () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Opening }))).toThrow(
      InvalidTransactionError,
    );
    const opening = WagerTransaction.createOpening({
      id: 't-0',
      providerId: 'internal',
      externalTransactionId: 'opening-w-1',
      idempotencyKey: 'internal:opening-w-1',
      payloadHash: 'h',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'opening',
      gameId: 'opening',
      money: brl('100.00'),
      createdAt: NOW,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Pending);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Refund }))).toThrow(
      InvalidTransactionError,
    );
    expect(() => WagerTransaction.create(props({ kind: Kind.Rollback }))).toThrow(
      InvalidTransactionError,
    );
    const refund = WagerTransaction.create(
      props({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    expect(refund.requiresReference()).toBe(true);
    expect(WagerTransaction.create(props()).requiresReference()).toBe(false);
  });

  test('BET e WIN exigem valor positivo; LOSS aceita zero', () => {
    expect(() => WagerTransaction.create(props({ money: brl('0.00') }))).toThrow(
      InvalidTransactionError,
    );
    expect(() => WagerTransaction.create(props({ kind: Kind.Win, money: brl('0.00') }))).toThrow(
      InvalidTransactionError,
    );
    expect(WagerTransaction.create(props({ kind: Kind.Loss, money: brl('0.00') })).status).toBe(
      Status.Pending,
    );
  });

  test.each([
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'payloadHash',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
  ])('rejeita campo vazio: %p', (field) => {
    expect(() => WagerTransaction.create(props({ [field]: ' ' }))).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction: transições', () => {
  test('PENDING -> PROCESSED registra saldo e data, e vira terminal', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed({ at: LATER, resultingBalance: brl('75.00') });

    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(LATER);
    expect(tx.resultingBalance?.toString()).toBe('75.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> REJECTED guarda o failureCode e vira terminal', () => {
    const tx = WagerTransaction.create(props());
    tx.reject(FailureCode.InsufficientFunds, LATER);

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.resultingBalance).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> FAILED guarda o failureCode e vira terminal', () => {
    const tx = WagerTransaction.create(props());
    tx.fail(FailureCode.InfrastructureFailure, LATER);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING_REFERENCE não é terminal e pode virar PROCESSED com a referência', () => {
    const tx = WagerTransaction.create(
      props({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }),
    );
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);

    tx.markPendingReference(); // novas tentativas são permitidas
    tx.markProcessed({ at: LATER, resultingBalance: brl('125.00'), referenceTransactionId: 'ref-1' });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref-1');
  });

  test('estado terminal não aceita nenhuma transição', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed({ at: LATER, resultingBalance: brl('75.00') });

    expect(() => tx.markProcessed({ at: LATER, resultingBalance: brl('1.00') })).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, LATER)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.InfrastructureFailure, LATER)).toThrow(
      InvalidTransactionStateError,
    );
    expect(tx.status).toBe(Status.Processed);
  });

  test('rehydrate não revalida, mas o estado terminal continua protegido', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(),
      status: Status.Processed,
      processedAt: LATER,
      resultingBalance: brl('75.00'),
    });
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds, LATER)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransaction: consultas de domínio', () => {
  test('affectsBalance é falso apenas para LOSS', () => {
    expect(WagerTransaction.create(props({ kind: Kind.Loss })).affectsBalance()).toBe(false);
    expect(WagerTransaction.create(props({ kind: Kind.Bet })).affectsBalance()).toBe(true);
    expect(WagerTransaction.create(props({ kind: Kind.Win })).affectsBalance()).toBe(true);
  });

  test('matchesPayload compara o hash', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.matchesPayload('hash-1')).toBe(true);
    expect(tx.matchesPayload('outro')).toBe(false);
  });

  test('sentido do lançamento: BET debita; WIN e REFUND creditam', () => {
    expect(WagerTransaction.create(props({ kind: Kind.Bet })).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );
    expect(WagerTransaction.create(props({ kind: Kind.Win })).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    const refund = WagerTransaction.create(
      props({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-1' }),
    );
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK é o inverso do lançamento da referência', () => {
    const bet = WagerTransaction.create(props({ kind: Kind.Bet }));
    const win = WagerTransaction.create(props({ kind: Kind.Win }));
    const refund = WagerTransaction.create(
      props({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-1' }),
    );
    const rollback = WagerTransaction.create(
      props({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-1' }),
    );

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência e LOSS não definem sentido de lançamento', () => {
    const rollback = WagerTransaction.create(
      props({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-1' }),
    );
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() =>
      WagerTransaction.create(props({ kind: Kind.Loss })).ledgerDirectionFor(),
    ).toThrow(InvalidTransactionStateError);
  });
});
