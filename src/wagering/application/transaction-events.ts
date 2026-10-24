import { WalletBalanceChanged } from '../../wallet/domain/wallet-balance-changed';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events';
import { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';

export interface EventParams {
  wallet: Wallet;
  tx: WagerTransaction;
  entry?: WalletLedgerEntry;
  correlationId: string;
  now: Date;
  newId: () => string;
}

function contextOf(p: EventParams) {
  return { eventId: p.newId(), correlationId: p.correlationId, causationId: p.tx.id, occurredAt: p.now };
}

/** Eventos de um resultado final: processada (+ saldo alterado, se houve lançamento) ou rejeitada. */
export function outcomeEvents(p: EventParams): OutboxMessage[] {
  if (p.tx.status === WagerTransactionStatus.Processed) {
    const messages = [OutboxMessage.enqueue(WagerTransactionProcessed.from(p.tx, contextOf(p)))];
    if (p.entry) {
      // Só quando o saldo muda (LOSS não gera este evento).
      messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(p.wallet, p.entry, contextOf(p))));
    }
    return messages;
  }
  if (p.tx.status === WagerTransactionStatus.Rejected) {
    return [OutboxMessage.enqueue(WagerTransactionRejected.from(p.tx, contextOf(p)))];
  }
  return [];
}

export function pendingReferenceEvent(p: EventParams): OutboxMessage {
  return OutboxMessage.enqueue(WagerTransactionPendingReference.from(p.tx, contextOf(p)));
}
