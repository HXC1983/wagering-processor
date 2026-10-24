import { randomUUID } from 'node:crypto';
import type { LogFn } from '../../shared/application/log';
import type { TransactionRunner, TransactionScope } from '../../shared/application/transaction-scope';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { TransactionApplier } from './transaction-applier';
import { outcomeEvents } from './transaction-events';

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

export interface PendingReferenceReader {
  /** Pendentes com a próxima tentativa vencida. Leitura sem lock: quem decide é a transação do worker. */
  findDue(limit: number, now: Date): Promise<PendingReferenceCandidate[]>;
}

export interface ReprocessResult {
  examined: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
}

type Resolution = 'processed' | 'rejected' | 'pending' | 'skipped';

export interface ReprocessOptions {
  clock?: () => Date;
  newId?: () => string;
  batchSize?: number;
  log?: LogFn;
}

/**
 * Reprocessa REFUND/ROLLBACK que chegaram antes da referência. Cada candidata é resolvida
 * em uma transação própria: trava a wallet (mesma ordem da API), relê a transação já travado
 * e só então decide, de modo que vários workers concorrentes nunca aplicam duas vezes.
 */
export class ReprocessPendingReferencesUseCase {
  readonly batchSize: number;
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private readonly log: LogFn;
  private readonly applier: TransactionApplier;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly reader: PendingReferenceReader,
    options: ReprocessOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.clock = options.clock ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.log = options.log ?? (() => undefined);
    this.applier = new TransactionApplier(this.newId);
  }

  async runOnce(): Promise<ReprocessResult> {
    const candidates = await this.reader.findDue(this.batchSize, this.clock());
    const result: ReprocessResult = {
      examined: candidates.length,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      skipped: 0,
    };

    for (const candidate of candidates) {
      let resolution: Resolution;
      try {
        resolution = await this.runner.run((scope) => this.resolve(scope, candidate));
      } catch (error) {
        this.log('error', 'pending reference reprocess failed', {
          transactionId: candidate.id,
          walletId: candidate.walletId,
          error: error instanceof Error ? error.message : String(error),
        });
        result.skipped += 1;
        continue;
      }
      if (resolution === 'processed') result.processed += 1;
      else if (resolution === 'rejected') result.rejected += 1;
      else if (resolution === 'pending') result.stillPending += 1;
      else result.skipped += 1;
    }
    return result;
  }

  private async resolve(scope: TransactionScope, candidate: PendingReferenceCandidate): Promise<Resolution> {
    const at = this.clock();

    // 1) Wallet primeiro, 2) transação depois: a mesma ordem de lock da API.
    const wallet = await scope.findWalletForUpdate(candidate.walletId);
    if (!wallet) {
      return 'skipped';
    }
    const tx = await scope.findTransactionById(candidate.id);
    if (!tx || !tx.isReferenceRetryDue(at)) {
      return 'skipped'; // outro worker (ou a API) já resolveu, ou ainda não venceu
    }

    const reference = await scope.findTransactionByExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId as string,
    );
    const existingReversal = reference ? await scope.findProcessedReversalOf(reference.id) : undefined;
    const outcome = this.applier.apply(wallet, tx, at, reference, existingReversal);

    if (outcome.kind === 'waiting') {
      const exhausted = tx.registerReferenceAttempt(at);
      if (!exhausted) {
        await scope.updateTransaction(tx);
        return 'pending';
      }
      tx.reject(FailureCode.ReferenceNotFound, at, wallet.balance);
      await scope.updateTransaction(tx);
      await this.emit(scope, wallet, tx, undefined, at);
      this.log('warn', 'pending reference rejected: attempts exhausted', {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        attempts: tx.referenceAttempts,
      });
      return 'rejected';
    }

    await scope.updateTransaction(tx);
    if (outcome.entry) {
      await scope.updateWallet(wallet);
      await scope.insertLedgerEntry(outcome.entry);
    }
    await this.emit(scope, wallet, tx, outcome.entry, at);
    return tx.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
  }

  private async emit(
    scope: TransactionScope,
    wallet: Parameters<typeof outcomeEvents>[0]['wallet'],
    tx: Parameters<typeof outcomeEvents>[0]['tx'],
    entry: Parameters<typeof outcomeEvents>[0]['entry'],
    at: Date,
  ): Promise<void> {
    for (const message of outcomeEvents({ wallet, tx, entry, correlationId: tx.id, now: at, newId: this.newId })) {
      await scope.insertOutboxMessage(message);
    }
  }
}
