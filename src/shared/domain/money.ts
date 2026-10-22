import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  /** String decimal canônica com exatamente 2 casas, ex.: "25.00". */
  amount: string;
  /** ISO-4217, ex.: "BRL". */
  currency: string;
}

// Forma canônica: sem sinal, sem zeros à esquerda, exatamente 2 casas.
// Ser canônica garante que o mesmo valor sempre gere o mesmo hash de payload.
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 100n;

/**
 * Valor monetário imutável. Internamente guarda centavos em bigint
 * (exato, sem ponto flutuante). Só nasce não negativo a partir de entrada
 * externa; valores negativos surgem apenas de operações (subtract, negate).
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency inválida: use 3 letras maiúsculas (ex.: "BRL")');
    }
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'amount inválido: use string decimal não negativa com exatamente 2 casas (ex.: "25.00")',
      );
    }

    const [integer, fraction] = amount.split('.');
    return new Money(BigInt(integer) * SCALE + BigInt(fraction), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toString(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / SCALE;
    const fraction = (abs % SCALE).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${integer}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}
