import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const AMOUNT_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const Exact = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -50,
  toExpPos: 50,
});

const UPPER_BOUND = new Exact("1000000000000000000");

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError("currency must be a three-letter ISO-4217 code");
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  static rehydrate(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(new Exact(0), currency);
  }

  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static of(value: Decimal, currency: string): Money {
    if (value.abs().greaterThanOrEqualTo(UPPER_BOUND)) {
      throw new InvalidMoneyError("amount exceeds the supported range");
    }
    return new Money(value.isZero() ? new Exact(0) : value, currency);
  }

  private static parse(props: MoneyProps, allowNegative: boolean): Money {
    if (typeof props !== "object" || props === null) {
      throw new InvalidMoneyError("money must be an object with amount and currency");
    }
    const { amount, currency } = props;
    assertCurrency(currency);
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`amount must be a plain decimal string with at most ${SCALE} decimal places`);
    }
    if (!allowNegative && amount.startsWith("-")) {
      throw new InvalidMoneyError("amount must not be negative");
    }
    return Money.of(new Exact(amount), currency);
  }
}
