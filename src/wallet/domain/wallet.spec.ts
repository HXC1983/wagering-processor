import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { InsufficientFundsError, InvalidAmountError, InvalidWalletError } from './errors';
import { LedgerDirection } from './ledger-direction';
import { Wallet } from './wallet';

const NOW = new Date('2026-10-23T15:00:00.000Z');
const LATER = new Date('2026-10-23T15:00:05.000Z');

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const openWallet = (initial = '100.00'): Wallet =>
  Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), now: NOW });

const move = (amount: string, n = 1) => ({
  amount: brl(amount),
  transactionId: `t-${n}`,
  entryId: `e-${n}`,
  at: LATER,
});

describe('Wallet.open', () => {
  test('nasce com version 1 e o saldo inicial', () => {
    const wallet = openWallet();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toEqual(NOW);
    expect(wallet.updatedAt).toEqual(NOW);
  });

  test('aceita saldo inicial zero', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('1.00').negate(), now: NOW }),
    ).toThrow(InvalidWalletError);
  });
});

describe('Wallet.debit', () => {
  test('reduz o saldo, sobe a version e devolve o lançamento DEBIT', () => {
    const wallet = openWallet();
    const entry = wallet.debit(move('25.00'));

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('w-1');
    expect(entry.transactionId).toBe('t-1');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('permite debitar exatamente o saldo inteiro', () => {
    const wallet = openWallet();
    const entry = wallet.debit(move('100.00'));
    expect(wallet.balance.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('0.00');
  });

  test('saldo insuficiente lança erro e não altera a wallet', () => {
    const wallet = openWallet('50.00');
    expect(() => wallet.debit(move('80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(NOW);
  });

  test('cenário do desafio em sequência: 100.00 com duas apostas de 80.00', () => {
    const wallet = openWallet('100.00');
    wallet.debit(move('80.00', 1));
    expect(() => wallet.debit(move('80.00', 2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('moeda diferente lança erro de domínio e não altera a wallet', () => {
    const wallet = openWallet();
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() =>
      wallet.debit({ amount: usd, transactionId: 't-1', entryId: 'e-1', at: LATER }),
    ).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('valor zero é rejeitado', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(move('0.00'))).toThrow(InvalidAmountError);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.credit', () => {
  test('aumenta o saldo, sobe a version e devolve o lançamento CREDIT', () => {
    const wallet = openWallet();
    const entry = wallet.credit(move('25.00'));

    expect(wallet.balance.toString()).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('125.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('moeda diferente e valor zero são rejeitados sem alterar a wallet', () => {
    const wallet = openWallet();
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() =>
      wallet.credit({ amount: usd, transactionId: 't-1', entryId: 'e-1', at: LATER }),
    ).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move('0.00'))).toThrow(InvalidAmountError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet: version e persistência', () => {
  test('a version só sobe quando o saldo muda', () => {
    const wallet = openWallet('50.00');
    expect(() => wallet.debit(move('80.00', 1))).toThrow();
    expect(() => wallet.credit(move('0.00', 2))).toThrow();
    expect(wallet.version).toBe(1);

    wallet.credit(move('10.00', 3));
    wallet.debit(move('5.00', 4));
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toString()).toBe('55.00');
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const state = openWallet().toState();
    const copy = Wallet.rehydrate({ ...state, version: 7 });
    expect(copy.version).toBe(7);
    expect(copy.balance.equals(state.balance)).toBe(true);
    expect(copy.id).toBe('w-1');
  });
});
