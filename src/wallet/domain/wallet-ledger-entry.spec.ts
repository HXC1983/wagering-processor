import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerInconsistencyError } from './errors';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

const NOW = new Date('2026-10-23T15:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const base = {
  id: 'e-1',
  walletId: 'w-1',
  transactionId: 't-1',
  direction: LedgerDirection.Credit,
  money: brl('10.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('110.00'),
  createdAt: NOW,
};

describe('WalletLedgerEntry.create', () => {
  test('aceita crédito e débito com aritmética correta', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    const debit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      balanceAfter: brl('90.00'),
    });
    expect(debit.isBalanced()).toBe(true);
  });

  test('rejeita aritmética inconsistente', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('111.00') })).toThrow(
      LedgerInconsistencyError,
    );
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit })).toThrow(
      LedgerInconsistencyError,
    );
  });

  test('rejeita valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('100.00') }),
    ).toThrow(LedgerInconsistencyError);
  });

  test('rejeita saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(LedgerInconsistencyError);
  });

  test('rejeita moedas diferentes', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: Money.from({ amount: '10.00', currency: 'USD' }) }),
    ).toThrow(CurrencyMismatchError);
  });

  test('a instância é imutável (congelada)', () => {
    expect(Object.isFrozen(WalletLedgerEntry.create(base))).toBe(true);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('não revalida: reconstrói o estado persistido como está', () => {
    const entry = WalletLedgerEntry.rehydrate({ ...base, balanceAfter: brl('999.00') });
    expect(entry.balanceAfter.toString()).toBe('999.00');
    expect(entry.isBalanced()).toBe(false);
  });
});
