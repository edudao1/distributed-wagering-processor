import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money/money";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("serializes with a fixed scale of two decimal places", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("25.5").toJSON()).toEqual({ amount: "25.50", currency: "BRL" });
    expect(brl("0.01").amount).toBe("0.01");
    expect(brl("1000.00").toString()).toBe("1000.00 BRL");
  });

  test("adds and subtracts without floating point drift", () => {
    expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
    expect(brl("999999999999999.99").add(brl("0.01")).amount).toBe("1000000000000000.00");
  });

  test.each([
    "",
    " ",
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e3",
    "1E3",
    "10.001",
    "10.005",
    "-5.00",
    " 5",
    "5 ",
    "+5",
    ".5",
    "5.",
    "05",
    "0x10",
    "1,00",
  ])("rejects the invalid amount %p instead of rounding it", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejects non-string amounts", () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: Number.NaN as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["", "brl", "BR", "BRLL", "R$", "12A"])("rejects the invalid currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("rejects amounts beyond the persisted precision", () => {
    expect(() => brl("1000000000000000000.00")).toThrow(InvalidMoneyError);
  });

  test("forbids operations across currencies", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl("1.00").equals(usd)).toBe(false);
  });

  test("is immutable", () => {
    const original = brl("10.00");
    const sum = original.add(brl("5.00"));
    expect(original.amount).toBe("10.00");
    expect(sum.amount).toBe("15.00");
    expect(sum).not.toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
  });

  test("exposes sign predicates and negation", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.00").negate().amount).toBe("0.00");
    expect(brl("3.00").isPositive()).toBe(true);
    expect(brl("3.00").negate().isNegative()).toBe(true);
    expect(brl("3.00").negate().amount).toBe("-3.00");
    expect(brl("3.00").isLessThan(brl("3.01"))).toBe(true);
    expect(brl("3.00").equals(brl("3"))).toBe(true);
  });

  test("rehydrate accepts signed values that only exist internally", () => {
    expect(Money.rehydrate({ amount: "-5.00", currency: "BRL" }).isNegative()).toBe(true);
    expect(() => Money.rehydrate({ amount: "1.234", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("zero is valid for any ISO currency", () => {
    expect(Money.zero("EUR").toJSON()).toEqual({ amount: "0.00", currency: "EUR" });
    expect(() => Money.zero("eur")).toThrow(InvalidMoneyError);
  });
});
