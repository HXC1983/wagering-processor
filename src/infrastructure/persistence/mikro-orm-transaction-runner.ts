import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  TransactionRunner,
  TransactionScope,
  UniqueViolationError,
} from '../../shared/application/transaction-scope';
import { InboxMessage } from '../../wagering/domain/inbox-message';
import { OutboxMessage } from '../../wagering/domain/outbox-message';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../wagering/domain/wager-transaction-status';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import {
  inboxFromRow,
  inboxToRow,
  ledgerEntryToRow,
  outboxToRow,
  wagerTransactionFromRow,
  wagerTransactionToRow,
  walletFromRow,
  walletToRow,
} from './mappers';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionRow,
  WagerTransactionSchema,
  WalletRow,
  WalletSchema,
} from './schemas';

function constraintOf(error: UniqueConstraintViolationException): string {
  const direct = (error as unknown as { constraint?: unknown }).constraint;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const match = /constraint "([^"]+)"/.exec(error.message);
  return match?.[1] ?? 'unknown';
}

class MikroOrmTransactionScope implements TransactionScope {
  /** Linhas já carregadas nesta transação (permitem o update por cópia de campos). */
  private readonly wallets = new Map<string, WalletRow>();
  private readonly transactions = new Map<string, WagerTransactionRow>();

  constructor(private readonly em: EntityManager) {}

  async findWalletForUpdate(walletId: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletSchema,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!row) {
      return undefined;
    }
    this.wallets.set(walletId, row);
    return walletFromRow(row);
  }

  async findTransactionByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionSchema, { providerId, idempotencyKey }));
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }));
  }

  async findTransactionById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionSchema, { id: transactionId }));
  }

  async findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(
      await this.em.findOne(WagerTransactionSchema, {
        referenceTransactionId,
        status: WagerTransactionStatus.Processed,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      }),
    );
  }

  async findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxSchema, { consumerName, messageId });
    return row ? inboxFromRow(row) : undefined;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    const row = this.em.create(WalletSchema, walletToRow(wallet));
    this.em.persist(row);
    await this.em.flush();
    this.wallets.set(wallet.id, row);
  }

  async updateWallet(wallet: Wallet): Promise<void> {
    const row = this.wallets.get(wallet.id);
    if (!row) {
      throw new Error(`wallet ${wallet.id} não foi carregada nesta transação`);
    }
    row.balance = wallet.balance.toString();
    row.version = wallet.version;
    row.updatedAt = wallet.updatedAt;
    await this.em.flush();
  }

  // Cada insert faz flush imediato: sem relações mapeadas, a ordem das FKs é a ordem das chamadas.
  async insertTransaction(transaction: WagerTransaction): Promise<void> {
    const row = this.em.create(WagerTransactionSchema, wagerTransactionToRow(transaction));
    this.em.persist(row);
    await this.em.flush();
    this.transactions.set(transaction.id, row);
  }

  async updateTransaction(transaction: WagerTransaction): Promise<void> {
    const row = this.transactions.get(transaction.id);
    if (!row) {
      throw new Error(`transação ${transaction.id} não foi carregada nesta transação`);
    }
    const next = wagerTransactionToRow(transaction);
    row.status = next.status;
    row.failureCode = next.failureCode;
    row.resultingBalance = next.resultingBalance;
    row.processedAt = next.processedAt;
    row.referenceTransactionId = next.referenceTransactionId;
    row.referenceAttempts = next.referenceAttempts;
    row.nextReferenceAttemptAt = next.nextReferenceAttemptAt;
    await this.em.flush();
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(this.em.create(LedgerEntrySchema, ledgerEntryToRow(entry)));
    await this.em.flush();
  }

  async insertOutboxMessage(message: OutboxMessage): Promise<void> {
    this.em.persist(this.em.create(OutboxSchema, outboxToRow(message)));
    await this.em.flush();
  }

  async insertInboxMessage(message: InboxMessage): Promise<void> {
    this.em.persist(this.em.create(InboxSchema, inboxToRow(message)));
    await this.em.flush();
  }

  private track(row: WagerTransactionRow | null): WagerTransaction | undefined {
    if (!row) {
      return undefined;
    }
    this.transactions.set(row.id, row);
    return wagerTransactionFromRow(row);
  }
}

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    // Um EntityManager novo (fork) por transação: Identity Map limpo e isolado.
    const em = this.orm.em.fork();
    try {
      return await em.transactional((transactionalEm) =>
        work(new MikroOrmTransactionScope(transactionalEm)),
      );
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new UniqueViolationError(constraintOf(error), error);
      }
      throw error;
    }
  }
}
