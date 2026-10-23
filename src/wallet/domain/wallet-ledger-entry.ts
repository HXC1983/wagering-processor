import { Money } from '../../shared/domain/money';
import { LedgerInconsistencyError } from './errors';
import { LedgerDirection } from './ledger-direction';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger. Sem campos mutáveis e sem métodos de
 * transição: a imutabilidade é estrutural (instância congelada).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética do lançamento: balanceBefore ± money === balanceAfter. */
  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.money.isPositive()) {
      throw new LedgerInconsistencyError('lançamento exige valor positivo');
    }
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new LedgerInconsistencyError('saldo do lançamento não pode ser negativo');
    }

    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.isBalanced()) {
      throw new LedgerInconsistencyError(
        `lançamento inconsistente: ${state.balanceBefore.toString()} ${state.direction} ${state.money.toString()} não resulta em ${state.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
