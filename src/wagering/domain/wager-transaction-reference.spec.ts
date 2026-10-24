import { describe, expect, test } from 'bun:test';
import { Money } from '../../shared/domain/money';
import { InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { REFERENCE_RETRY, WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';

const T0 = new Date('2026-10-23T15:00:00.000Z');

function pendingRefund(): WagerTransaction {
  return WagerTransaction.create({
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'h',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'r-1',
    gameId: 'g-1',
    kind: Kind.Refund,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: 'ext-bet',
    createdAt: T0,
  });
}

describe('WagerTransaction: espera pela referência', () => {
  test('markPendingReference agenda a primeira tentativa em 1 segundo', () => {
    const tx = pendingRefund();
    tx.markPendingReference(T0);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 1_000);
    expect(tx.isReferenceRetryDue(T0)).toBe(false);
    expect(tx.isReferenceRetryDue(new Date(T0.getTime() + 1_000))).toBe(true);
  });

  test('cada tentativa falha dobra a espera, com teto de 60 segundos, e a 8ª esgota', () => {
    const tx = pendingRefund();
    tx.markPendingReference(T0);

    const delays: number[] = [];
    for (let i = 1; i < REFERENCE_RETRY.maxAttempts; i += 1) {
      expect(tx.registerReferenceAttempt(T0)).toBe(false);
      expect(tx.referenceAttempts).toBe(i);
      delays.push((tx.nextReferenceAttemptAt as Date).getTime() - T0.getTime());
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);

    expect(tx.registerReferenceAttempt(T0)).toBe(true);
    expect(tx.referenceAttempts).toBe(REFERENCE_RETRY.maxAttempts);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test('registerReferenceAttempt só vale em PENDING_REFERENCE', () => {
    expect(() => pendingRefund().registerReferenceAttempt(T0)).toThrow(InvalidTransactionStateError);
  });

  test('resolver a pendência limpa o agendamento e a leva a um estado terminal', () => {
    const processed = pendingRefund();
    processed.markPendingReference(T0);
    processed.markProcessed({
      at: T0,
      resultingBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      referenceTransactionId: 'ref-1',
    });
    expect(processed.nextReferenceAttemptAt).toBeUndefined();
    expect(processed.isReferenceRetryDue(T0)).toBe(false);
    expect(processed.referenceTransactionId).toBe('ref-1');

    const rejected = pendingRefund();
    rejected.markPendingReference(T0);
    rejected.reject(FailureCode.ReferenceNotFound, T0);
    expect(rejected.nextReferenceAttemptAt).toBeUndefined();
    expect(rejected.isTerminal()).toBe(true);
  });

  test('rehydrate preserva as tentativas e o agendamento', () => {
    const tx = pendingRefund();
    tx.markPendingReference(T0);
    tx.registerReferenceAttempt(T0);
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy.referenceAttempts).toBe(1);
    expect(copy.nextReferenceAttemptAt).toEqual(tx.nextReferenceAttemptAt);
    expect(copy.status).toBe(Status.PendingReference);
  });
});
