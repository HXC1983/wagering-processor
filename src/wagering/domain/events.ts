import { EventContext, IntegrationEvent } from '../../shared/domain/integration-event';
import { MoneyProps } from '../../shared/domain/money';
import { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind } from './wager-transaction-kind';

interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Saldo da wallet observado no processamento. */
  resultingBalance: MoneyProps | null;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  processedAt: string | null;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: string | null;
  rejectedAt: string | null;
}

function baseData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    resultingBalance: tx.resultingBalance ? tx.resultingBalance.toJSON() : null,
  };
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...baseData(tx), processedAt: tx.processedAt ? tx.processedAt.toISOString() : null },
    });
  }
}

/** Rejeição por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...baseData(tx),
        failureCode: tx.failureCode ?? null,
        rejectedAt: tx.processedAt ? tx.processedAt.toISOString() : null,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string | null;
  nextAttemptAt: string | null;
}

/** REFUND/ROLLBACK recebido antes da transação referenciada. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...baseData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        nextAttemptAt: tx.nextReferenceAttemptAt ? tx.nextReferenceAttemptAt.toISOString() : null,
      },
    });
  }
}
