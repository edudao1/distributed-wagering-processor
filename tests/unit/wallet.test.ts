import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { AT, brl, openWallet } from "../support/builders";

const movement = (money: Money) => ({ entryId: randomUUID(), transactionId: randomUUID(), money, at: AT });

describe("Wallet", () => {
  test("opens with version 1 and an opening credit in the ledger", () => {
    const transactionId = randomUUID();
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: brl("1000.00"),
      at: AT,
      opening: { transactionId, entryId: randomUUID() },
    });
    const [entry, ...rest] = wallet.pullUncommittedEntries();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("1000.00");
    expect(rest).toHaveLength(0);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.transactionId).toBe(transactionId);
    expect(entry?.balanceBefore.amount).toBe("0.00");
    expect(entry?.balanceAfter.amount).toBe("1000.00");
  });

  test("opens with zero balance without ledger entries", () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl("0.00"), at: AT });
    expect(wallet.pullUncommittedEntries()).toHaveLength(0);
    expect(wallet.version).toBe(1);
  });

  test("requires an opening transaction for a positive initial balance", () => {
    expect(() =>
      Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl("1.00"), at: AT }),
    ).toThrow(InvalidWalletError);
  });

  test("debit moves balance, bumps version and records a balanced entry", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(movement(brl("80.00")));
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("20.00");
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.pullUncommittedEntries()).toEqual([entry]);
  });

  test("never allows a negative balance", () => {
    const wallet = openWallet("100.00");
    expect(wallet.canDebit(brl("100.01"))).toBe(false);
    expect(() => wallet.debit(movement(brl("100.01")))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.pullUncommittedEntries()).toHaveLength(0);
  });

  test("can debit the exact balance down to zero", () => {
    const wallet = openWallet("100.00");
    wallet.debit(movement(brl("100.00")));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("credit increases the balance", () => {
    const wallet = openWallet("10.00");
    wallet.credit(movement(brl("5.50")));
    expect(wallet.balance.amount).toBe("15.50");
    expect(wallet.version).toBe(2);
  });

  test("rejects movements in another currency", () => {
    const wallet = openWallet("10.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit(movement(usd))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(movement(usd))).toThrow(CurrencyMismatchError);
  });

  test("rejects zero movements", () => {
    const wallet = openWallet("10.00");
    expect(() => wallet.credit(movement(brl("0.00")))).toThrow(InvalidWalletError);
  });

  test("a transaction moves the wallet at most once", () => {
    const wallet = openWallet("10.00");
    const repeated = movement(brl("1.00"));
    wallet.credit(repeated);
    expect(() => wallet.credit({ ...repeated, entryId: randomUUID() })).toThrow(InvalidWalletError);
  });

  test("rehydrate restores state without creating ledger entries", () => {
    const wallet = openWallet("50.00");
    const restored = Wallet.rehydrate({ ...wallet.toState(), version: 7 });
    expect(restored.version).toBe(7);
    expect(restored.balance.amount).toBe("50.00");
    expect(restored.pullUncommittedEntries()).toHaveLength(0);
  });
});
