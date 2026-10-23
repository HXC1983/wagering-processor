import { randomUUID } from 'node:crypto';
import {
  TransactionRunner,
  TransactionScope,
  UniqueViolationError,
} from '../../shared/application/transaction-scope';
import { Money, MoneyProps } from '../../shared/domain/money';
import { isUuid } from '../../shared/domain/uuid';
import { WalletNotFoundError } from '../../wallet/application/errors';
import { InsufficientFundsError } from '../../wallet/domain/errors';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletBalanceChanged } from '../../wallet/domain/wallet-balance-changed';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { InvalidTransactionError } from '../domain/errors';
import { WagerTransactionProcessed, WagerTransactionRejected } from '../domain/events';
import { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { IdempotencyConflictError, InboxConflictError, UnsupportedTransactionKindError } from './errors';
import { hashPayload } from './payload-hash';

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
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

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

    // Validação de contrato antes de tocar no banco (lança InvalidTransactionError).
    const probe = build();
    if (probe.requiresReference()) {
      throw new UnsupportedTransactionKindError(
        `${probe.kind} ainda não é suportado nesta versão (Bloco E)`,
      );
    }

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

    // 4) Regra de negócio (domínio) e 5) gravação atômica.
    const entry = this.apply(wallet, tx, now);

    await scope.insertTransaction(tx);
    if (entry) {
      await scope.updateWallet(wallet);
      await scope.insertLedgerEntry(entry);
    }
    await this.enqueueEvents(scope, wallet, tx, entry, correlationId, now);
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

  /** Aplica a regra. Devolve o lançamento do ledger, ou undefined se o saldo não mudou. */
  private apply(wallet: Wallet, tx: WagerTransaction, now: Date): WalletLedgerEntry | undefined {
    if (tx.playerId !== wallet.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
      return undefined;
    }
    if (tx.money.currency !== wallet.currency) {
      tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      return undefined;
    }

    let entry: WalletLedgerEntry | undefined;
    try {
      const movement = { amount: tx.money, transactionId: tx.id, entryId: this.newId(), at: now };
      if (tx.kind === WagerTransactionKind.Bet) {
        entry = wallet.debit(movement);
      } else if (tx.kind === WagerTransactionKind.Win) {
        entry = wallet.credit(movement);
      }
      // LOSS: registra o resultado sem mover saldo.
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        tx.reject(FailureCode.InsufficientFunds, now, wallet.balance);
        return undefined;
      }
      throw error;
    }

    tx.markProcessed({ at: now, resultingBalance: wallet.balance });
    return entry;
  }

  private async enqueueEvents(
    scope: TransactionScope,
    wallet: Wallet,
    tx: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    const context = () => ({
      eventId: this.newId(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    if (tx.status === WagerTransactionStatus.Processed) {
      await scope.insertOutboxMessage(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, context())));
      if (entry) {
        // Só quando o saldo muda (LOSS não gera este evento).
        await scope.insertOutboxMessage(
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context())),
        );
      }
    } else if (tx.status === WagerTransactionStatus.Rejected) {
      await scope.insertOutboxMessage(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, context())));
    }
  }

  private toResult(
    tx: WagerTransaction,
    idempotentReplay: boolean,
    wallet: Wallet,
  ): ProcessWagerTransactionResult {
    const result: ProcessWagerTransactionResult = {
      transactionId: tx.id,
      status: tx.status,
      // No replay devolvemos o saldo observado na época, e não o saldo atual.
      balance: (tx.resultingBalance ?? wallet.balance).toJSON(),
      idempotentReplay,
    };
    if (tx.failureCode) {
      result.failureCode = tx.failureCode;
    }
    return result;
  }
}
