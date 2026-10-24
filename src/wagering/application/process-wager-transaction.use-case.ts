import { randomUUID } from 'node:crypto';
import {
  TransactionRunner,
  TransactionScope,
  UniqueViolationError,
} from '../../shared/application/transaction-scope';
import { Money, MoneyProps } from '../../shared/domain/money';
import { isUuid } from '../../shared/domain/uuid';
import { WalletNotFoundError } from '../../wallet/application/errors';
import type { Wallet } from '../../wallet/domain/wallet';
import { InvalidTransactionError } from '../domain/errors';
import type { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import type { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { IdempotencyConflictError, InboxConflictError } from './errors';
import { hashPayload } from './payload-hash';
import { TransactionApplier } from './transaction-applier';
import { outcomeEvents, pendingReferenceEvent } from './transaction-events';

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

/** Presente quando a entrada é uma mensagem de fila: o inbox participa da mesma transação SQL. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessOptions {
  inbox?: InboxContext;
}

/** Constraints de unicidade que indicam corrida (ou conflito) na idempotência. */
const IDEMPOTENCY_CONSTRAINTS = new Set([
  'wager_tx_provider_idempotency_uq',
  'wager_tx_provider_external_uq',
]);
const MAX_ATTEMPTS = 2;

export class ProcessWagerTransactionUseCase {
  private readonly applier: TransactionApplier;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {
    this.applier = new TransactionApplier(this.newId);
  }

  async execute(
    command: ProcessWagerTransactionCommand,
    options: ProcessOptions = {},
  ): Promise<ProcessWagerTransactionResult> {
    this.validate(command);

    const money = Money.from(command.money);
    // O header de idempotência fica fora do hash; só os campos de negócio entram.
    const payloadHash = hashPayload({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });
    const correlationId = command.correlationId ?? this.newId();
    const now = this.clock();

    const build = (): WagerTransaction =>
      WagerTransaction.create({
        id: this.newId(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: now,
      });

    build(); // validação de contrato antes de tocar no banco (lança InvalidTransactionError)

    for (let attempt = 1; ; attempt += 1) {
      try {
        // Uma instância nova por tentativa: a anterior pode ter sido mutada antes do rollback.
        return await this.runner.run((scope) =>
          this.process(scope, build(), correlationId, now, options.inbox),
        );
      } catch (error) {
        const idempotencyRace =
          error instanceof UniqueViolationError && IDEMPOTENCY_CONSTRAINTS.has(error.constraint);
        if (!idempotencyRace) {
          throw error;
        }
        // Corrida entre wallets diferentes com a mesma chave: na 2ª tentativa a leitura
        // encontra a transação existente (replay ou conflito).
        if (attempt >= MAX_ATTEMPTS) {
          throw new IdempotencyConflictError(
            'a idempotency key ou a externalTransactionId já está em uso por outra transação',
          );
        }
      }
    }
  }

  private validate(command: ProcessWagerTransactionCommand): void {
    if (!isUuid(command.walletId)) {
      throw new InvalidTransactionError('walletId deve ser um UUID válido');
    }
    if (!isUuid(command.playerId)) {
      throw new InvalidTransactionError('playerId deve ser um UUID válido');
    }
    if (!Object.values(WagerTransactionKind).includes(command.kind)) {
      throw new InvalidTransactionError(`kind inválido: ${String(command.kind)}`);
    }
  }

  private async process(
    scope: TransactionScope,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
    inbox?: InboxContext,
  ): Promise<ProcessWagerTransactionResult> {
    // 1) Trava a wallet ANTES de inserir qualquer linha que a referencie por FK:
    //    inverter essa ordem causaria deadlock entre requisições da mesma wallet.
    const wallet = await scope.findWalletForUpdate(tx.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet não encontrada: ${tx.walletId}`);
    }

    // 2) Inbox (só entrada por fila): mensagem já recebida por este consumidor?
    let alreadyReceived = false;
    if (inbox) {
      const received = await scope.findInboxMessage(inbox.consumerName, inbox.messageId);
      if (received) {
        alreadyReceived = true;
        if (received.payloadHash !== inbox.payloadHash) {
          throw new InboxConflictError(
            `a messageId ${inbox.messageId} já foi recebida com um payload diferente`,
          );
        }
        // Redelivery: o commit anterior gravou transação e inbox juntos, então só devolvemos o resultado.
        const done = await scope.findTransactionByIdempotencyKey(tx.providerId, tx.idempotencyKey);
        if (done) {
          return this.toResult(done, true, wallet);
        }
      }
    }

    // 3) Idempotência: com o lock, quem chega depois enxerga o commit de quem chegou antes.
    const existing = await scope.findTransactionByIdempotencyKey(tx.providerId, tx.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(tx.payloadHash)) {
        throw new IdempotencyConflictError(
          `a idempotency key ${tx.idempotencyKey} já foi usada com um payload diferente`,
        );
      }
      // Replay: a mensagem também precisa constar no inbox para a próxima entrega ser reconhecida.
      if (!alreadyReceived) {
        await this.recordInbox(scope, inbox, now);
      }
      return this.toResult(existing, true, wallet);
    }

    // 4) Referência (REFUND/ROLLBACK) e regras de negócio.
    const reference = tx.requiresReference()
      ? await scope.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId as string)
      : undefined;
    const existingReversal = reference ? await scope.findProcessedReversalOf(reference.id) : undefined;
    const outcome = this.applier.apply(wallet, tx, now, reference, existingReversal);

    // 5) Gravação atômica.
    const eventParams = { wallet, tx, correlationId, now, newId: this.newId };
    if (outcome.kind === 'waiting') {
      tx.markPendingReference(now);
      await scope.insertTransaction(tx);
      await scope.insertOutboxMessage(pendingReferenceEvent(eventParams));
    } else {
      await scope.insertTransaction(tx);
      if (outcome.entry) {
        await scope.updateWallet(wallet);
        await scope.insertLedgerEntry(outcome.entry);
      }
      for (const message of outcomeEvents({ ...eventParams, entry: outcome.entry })) {
        await scope.insertOutboxMessage(message);
      }
    }
    if (!alreadyReceived) {
      await this.recordInbox(scope, inbox, now);
    }

    return this.toResult(tx, false, wallet);
  }

  private async recordInbox(scope: TransactionScope, inbox: InboxContext | undefined, now: Date): Promise<void> {
    if (!inbox) {
      return;
    }
    const message = InboxMessage.receive({
      messageId: inbox.messageId,
      consumerName: inbox.consumerName,
      payloadHash: inbox.payloadHash,
      receivedAt: now,
    });
    message.markProcessed(now);
    await scope.insertInboxMessage(message);
  }

  private toResult(
    tx: WagerTransaction,
    idempotentReplay: boolean,
    wallet: Wallet,
  ): ProcessWagerTransactionResult {
    const result: ProcessWagerTransactionResult = {
      transactionId: tx.id,
      status: tx.status,
      // No replay devolvemos o saldo observado na época; pendente: o saldo atual.
      balance: (tx.resultingBalance ?? wallet.balance).toJSON(),
      idempotentReplay,
    };
    if (tx.failureCode) {
      result.failureCode = tx.failureCode;
    }
    return result;
  }
}
