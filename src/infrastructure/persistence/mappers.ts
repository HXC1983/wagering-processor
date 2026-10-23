import { Money } from '../../shared/domain/money';
import { FailureCode } from '../../wagering/domain/failure-code';
import { OutboxMessage } from '../../wagering/domain/outbox-message';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../wagering/domain/wager-transaction-status';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { LedgerEntryRow, OutboxRow, WagerTransactionRow, WalletRow } from './schemas';

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function walletToRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function wagerTransactionFromRow(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode as FailureCode | null) ?? undefined,
    resultingBalance:
      row.resultingBalance !== null
        ? Money.from({ amount: row.resultingBalance, currency: row.currency })
        : undefined,
    processedAt: row.processedAt ?? undefined,
  });
}

export function wagerTransactionToRow(tx: WagerTransaction): WagerTransactionRow {
  const s = tx.toState();
  return {
    id: s.id,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    idempotencyKey: s.idempotencyKey,
    payloadHash: s.payloadHash,
    walletId: s.walletId,
    playerId: s.playerId,
    roundId: s.roundId,
    gameId: s.gameId,
    kind: s.kind,
    amount: s.money.toString(),
    currency: s.money.currency,
    referenceExternalTransactionId: s.referenceExternalTransactionId ?? null,
    referenceTransactionId: s.referenceTransactionId ?? null,
    status: s.status,
    failureCode: s.failureCode ?? null,
    resultingBalance: s.resultingBalance ? s.resultingBalance.toString() : null,
    referenceAttempts: 0,
    nextReferenceAttemptAt: null,
    createdAt: s.createdAt,
    processedAt: s.processedAt ?? null,
  };
}

export function ledgerEntryToRow(entry: WalletLedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt,
  };
}

export function outboxToRow(message: OutboxMessage): OutboxRow {
  const s = message.toState();
  return {
    id: s.id,
    aggregateId: s.aggregateId,
    eventType: s.eventType,
    payload: { ...s.payload },
    occurredAt: s.occurredAt,
    attempts: s.attempts,
    nextAttemptAt: s.nextAttemptAt ?? null,
    publishedAt: s.publishedAt ?? null,
  };
}
