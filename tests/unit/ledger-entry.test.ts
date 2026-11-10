import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { InvalidLedgerEntryError } from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../src/domain/money/money";
import { AT, brl } from "../support/builders";

const entry = (direction: LedgerDirection, money: string, before: string, after: string) =>
  WalletLedgerEntry.create({
    id: randomUUID(),
    walletId: randomUUID(),
    transactionId: randomUUID(),
    direction,
    money: brl(money),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    createdAt: AT,
  });

describe("WalletLedgerEntry", () => {
  test("accepts balanced credits and debits", () => {
    expect(entry(LedgerDirection.Credit, "10.00", "5.00", "15.00").isBalanced()).toBe(true);
    expect(entry(LedgerDirection.Debit, "10.00", "15.00", "5.00").signedAmount().amount).toBe("-10.00");
  });

  test("rejects arithmetic that does not balance", () => {
    expect(() => entry(LedgerDirection.Credit, "10.00", "5.00", "16.00")).toThrow(InvalidLedgerEntryError);
    expect(() => entry(LedgerDirection.Debit, "10.00", "15.00", "25.00")).toThrow(InvalidLedgerEntryError);
  });

  test("rejects zero amounts and negative balances", () => {
    expect(() => entry(LedgerDirection.Credit, "0.00", "5.00", "5.00")).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: randomUUID(),
        transactionId: randomUUID(),
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("5.00"),
        balanceAfter: Money.rehydrate({ amount: "-5.00", currency: "BRL" }),
        createdAt: AT,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects mixed currencies", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: randomUUID(),
        transactionId: randomUUID(),
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "1.00", currency: "USD" }),
        balanceBefore: brl("0.00"),
        balanceAfter: brl("1.00"),
        createdAt: AT,
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("is structurally immutable", () => {
    const created = entry(LedgerDirection.Credit, "1.00", "0.00", "1.00");
    expect(Object.isFrozen(created)).toBe(true);
    expect(() => {
      (created as unknown as { direction: string }).direction = "DEBIT";
    }).toThrow(TypeError);
  });
});
