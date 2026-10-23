import { CurrencyMismatchError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { InsufficientFundsError, InvalidAmountError, InvalidWalletError } from './errors';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
}

export interface MovementProps {
  amount: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Aggregate root. Toda alteração de saldo devolve o lançamento de ledger
 * correspondente, e a version só incrementa quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('saldo inicial não pode ser negativo');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstrução a partir da persistência: não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  debit(movement: MovementProps): WalletLedgerEntry {
    this.assertMovement(movement.amount);
    if (this._balance.isLessThan(movement.amount)) {
      throw new InsufficientFundsError(
        `saldo insuficiente: disponível ${this._balance.toString()}, solicitado ${movement.amount.toString()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, movement, this._balance.subtract(movement.amount));
  }

  credit(movement: MovementProps): WalletLedgerEntry {
    this.assertMovement(movement.amount);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.amount));
  }

  private apply(direction: LedgerDirection, movement: MovementProps, newBalance: Money): WalletLedgerEntry {
    // O lançamento é criado (e validado) antes de mudar qualquer estado:
    // se algo falhar, a wallet permanece intacta.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.amount,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: movement.at,
    });

    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovement(amount: Money): void {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidAmountError('o valor da movimentação deve ser positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `a wallet é ${this.currency}, mas a operação é ${money.currency}`,
      );
    }
  }
}
