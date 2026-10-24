import type { InboxMessage } from '../../wagering/domain/inbox-message';
import type { OutboxMessage } from '../../wagering/domain/outbox-message';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';

/**
 * Porta da unidade de trabalho. Tudo que acontece dentro de uma chamada a
 * TransactionRunner.run() compartilha UMA transação SQL: ou tudo é confirmado,
 * ou nada é.
 */
export interface TransactionScope {
  /** Lê a wallet travando a linha (SELECT ... FOR UPDATE) até o fim da transação. */
  findWalletForUpdate(walletId: string): Promise<Wallet | undefined>;
  findTransactionByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findTransactionById(transactionId: string): Promise<WagerTransaction | undefined>;
  /** Reversão (REFUND ou ROLLBACK) já PROCESSADA dessa transação, se houver. */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  /** Atualiza uma wallet já carregada por findWalletForUpdate nesta mesma transação. */
  updateWallet(wallet: Wallet): Promise<void>;
  insertTransaction(transaction: WagerTransaction): Promise<void>;
  /** Atualiza uma transação já carregada nesta mesma transação (ex.: pendente que foi resolvida). */
  updateTransaction(transaction: WagerTransaction): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  insertOutboxMessage(message: OutboxMessage): Promise<void>;
  insertInboxMessage(message: InboxMessage): Promise<void>;
}

export interface TransactionRunner {
  /** Pode lançar UniqueViolationError quando uma constraint de unicidade é violada. */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export class UniqueViolationError extends Error {
  readonly constraint: string;

  constructor(constraint: string, cause?: unknown) {
    super(`violação de unicidade: ${constraint}`, { cause });
    this.name = 'UniqueViolationError';
    this.constraint = constraint;
  }
}
