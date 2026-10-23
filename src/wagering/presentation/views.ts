import type { WagerTransaction } from '../domain/wager-transaction';

export function toTransactionView(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    resultingBalance: tx.resultingBalance ? tx.resultingBalance.toJSON() : null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt ? tx.processedAt.toISOString() : null,
  };
}
