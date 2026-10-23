import { randomUUID } from 'node:crypto';
import { TransactionRunner, UniqueViolationError } from '../../shared/application/transaction-scope';
import { Money, MoneyProps } from '../../shared/domain/money';
import { isUuid } from '../../shared/domain/uuid';
import { hashPayload } from '../../wagering/application/payload-hash';
import { OutboxMessage } from '../../wagering/domain/outbox-message';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { InvalidWalletError } from '../domain/errors';
import { LedgerDirection } from '../domain/ledger-direction';
import { Wallet } from '../domain/wallet';
import { WalletBalanceChanged } from '../domain/wallet-balance-changed';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletAlreadyExistsError } from './errors';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const PLAYER_CURRENCY_CONSTRAINT = 'wallets_player_currency_uq';

export class OpenWalletUseCase {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    if (!isUuid(command.playerId)) {
      throw new InvalidWalletError('playerId deve ser um UUID válido');
    }
    const initial = Money.from(command.initialBalance);
    const now = this.clock();
    const wallet = Wallet.open({
      id: this.newId(),
      playerId: command.playerId,
      initialBalance: initial,
      now,
    });

    try {
      await this.runner.run(async (scope) => {
        await scope.insertWallet(wallet);
        if (!initial.isPositive()) {
          return; // saldo inicial zero: sem OPENING e sem lançamento
        }

        // Saldo inicial > 0: OPENING + lançamento CREDIT na MESMA transação SQL da wallet.
        const opening = WagerTransaction.createOpening({
          id: this.newId(),
          providerId: 'internal',
          externalTransactionId: `opening-${wallet.id}`,
          idempotencyKey: `internal:opening-${wallet.id}`,
          payloadHash: hashPayload({ kind: 'OPENING', walletId: wallet.id, money: initial.toJSON() }),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'opening',
          money: initial,
          createdAt: now,
        });
        opening.markProcessed({ at: now, resultingBalance: initial });
        await scope.insertTransaction(opening);

        const entry = WalletLedgerEntry.create({
          id: this.newId(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: initial,
          balanceBefore: Money.zero(initial.currency),
          balanceAfter: initial,
          createdAt: now,
        });
        await scope.insertLedgerEntry(entry);

        const event = WalletBalanceChanged.from(wallet, entry, {
          eventId: this.newId(),
          correlationId: opening.id,
          causationId: opening.id,
          occurredAt: now,
        });
        await scope.insertOutboxMessage(OutboxMessage.enqueue(event));
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === PLAYER_CURRENCY_CONSTRAINT) {
        throw new WalletAlreadyExistsError(
          `já existe uma wallet ${initial.currency} para o jogador ${command.playerId}`,
        );
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
