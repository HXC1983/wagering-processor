import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  test('aceita string decimal com 2 casas', () => {
    expect(brl('25.00').toString()).toBe('25.00');
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.05').toString()).toBe('0.05');
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '10',
    '10.5',
    '10.999',
    '-5.00',
    '+5.00',
    '05.00',
    '1,00',
    ' 10.00',
    '10.00 ',
    'abc',
  ])('rejeita amount inválido: %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (ex.: number vindo do JSON)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'B1L'])('rejeita currency inválida: %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money: aritmética exata', () => {
  test('0.10 + 0.20 é exatamente 0.30 (o clássico do ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('valores acima de Number.MAX_SAFE_INTEGER continuam exatos', () => {
    const big = brl('9007199254740993.00');
    expect(big.toString()).toBe('9007199254740993.00');
    expect(big.add(brl('0.01')).toString()).toBe('9007199254740993.01');
  });

  test('subtract pode resultar em valor negativo, sem lançar erro', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-15.00');
  });

  test('negate inverte o sinal', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('5.00').negate().negate().equals(brl('5.00'))).toBe(true);
  });

  test('cenário do desafio: 100.00 - 80.00 = 20.00, e 20.00 < 80.00', () => {
    const balance = brl('100.00').subtract(brl('80.00'));
    expect(balance.toString()).toBe('20.00');
    expect(balance.isLessThan(brl('80.00'))).toBe(true);
  });
});

describe('Money: imutabilidade e comparação', () => {
  test('operações devolvem nova instância e não alteram a original', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(sum).not.toBe(original);
    expect(original.toString()).toBe('10.00');
  });

  test('a instância é congelada', () => {
    expect(Object.isFrozen(brl('1.00'))).toBe(true);
  });

  test('equals, isPositive e isZero', () => {
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('2.00'))).toBe(false);
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
  });
});

describe('Money: moedas diferentes', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('add, subtract e isLessThan lançam erro de domínio', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('equals entre moedas diferentes é false (não lança)', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});

describe('Money: serialização', () => {
  test('toJSON devolve MoneyProps com amount em string', () => {
    expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
  });

  test('ida e volta preserva o valor', () => {
    const money = brl('1234.56');
    expect(Money.from(money.toJSON()).equals(money)).toBe(true);
  });
});
