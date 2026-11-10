import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { Money } from "../../src/domain/money/money";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { type ReferenceResolution, WagerSettlement } from "../../src/domain/wagering/wager-settlement";
import type { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import type { Wallet } from "../../src/domain/wallet/wallet";
import { AT, brl, openWallet, retryPolicy, transactionFor } from "../support/builders";

const settlement = new WagerSettlement();

function settle(transaction: WagerTransaction, wallet: Wallet, reference: ReferenceResolution = { type: "none" }) {
  return settlement.settle({ transaction, wallet, reference, retryPolicy, ledgerEntryId: randomUUID(), at: AT });
}

function processed(wallet: Wallet, kind: WagerTransactionKind, amount: string, externalTransactionId: string) {
  const transaction = transactionFor(wallet, {
    kind,
    money: brl(amount),
    externalTransactionId,
    referenceExternalTransactionId: kind === WagerTransactionKind.Refund ? "seed" : undefined,
  });
  transaction.markProcessed(undefined, AT, wallet.balance);
  return transaction;
}

const found = (transaction: WagerTransaction, alreadyReversed = false): ReferenceResolution => ({
  type: "found",
  transaction,
  alreadyReversed,
});

describe("BET", () => {
  test("debits the wallet once", () => {
    const wallet = openWallet("100.00");
    const bet = transactionFor(wallet, { money: brl("25.00") });
    const outcome = settle(bet, wallet);
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(outcome.status === WagerTransactionStatus.Processed && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("75.00");
    expect(bet.observedBalance?.amount).toBe("75.00");
  });

  test("is rejected with INSUFFICIENT_FUNDS and leaves no trace on the balance", () => {
    const wallet = openWallet("20.00");
    const bet = transactionFor(wallet, { money: brl("80.00") });
    const outcome = settle(bet, wallet);
    expect(outcome).toEqual({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(1);
    expect(wallet.pullUncommittedEntries()).toHaveLength(0);
  });
});

describe("WIN and LOSS", () => {
  test("WIN credits, with or without referencing the BET", () => {
    const wallet = openWallet("100.00");
    const bet = processed(wallet, WagerTransactionKind.Bet, "10.00", "bet-1");
    settle(transactionFor(wallet, { kind: WagerTransactionKind.Win, money: brl("30.00") }), wallet);
    const win = transactionFor(wallet, {
      kind: WagerTransactionKind.Win,
      money: brl("5.00"),
      referenceExternalTransactionId: "bet-1",
    });
    settle(win, wallet, found(bet));
    expect(wallet.balance.amount).toBe("135.00");
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("LOSS is processed without moving the balance or writing the ledger", () => {
    const wallet = openWallet("100.00");
    const outcome = settle(transactionFor(wallet, { kind: WagerTransactionKind.Loss, money: brl("0.00") }), wallet);
    expect(outcome).toEqual({ status: WagerTransactionStatus.Processed });
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });
});

describe("REFUND", () => {
  test("credits back a processed BET", () => {
    const wallet = openWallet("90.00");
    const bet = processed(wallet, WagerTransactionKind.Bet, "10.00", "bet-1");
    const refund = transactionFor(wallet, {
      kind: WagerTransactionKind.Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(settle(refund, wallet, found(bet)).status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("only once", () => {
    const wallet = openWallet("90.00");
    const bet = processed(wallet, WagerTransactionKind.Bet, "10.00", "bet-1");
    const refund = transactionFor(wallet, {
      kind: WagerTransactionKind.Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(settle(refund, wallet, found(bet, true))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.AlreadyReversed,
    });
  });

  test("must match the BET amount and may only reference a BET", () => {
    const wallet = openWallet("90.00");
    const bet = processed(wallet, WagerTransactionKind.Bet, "10.00", "bet-1");
    const win = processed(wallet, WagerTransactionKind.Win, "10.00", "win-1");
    const partial = transactionFor(wallet, {
      kind: WagerTransactionKind.Refund,
      money: brl("5.00"),
      referenceExternalTransactionId: "bet-1",
    });
    const ofWin = transactionFor(wallet, {
      kind: WagerTransactionKind.Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "win-1",
    });
    expect(settle(partial, wallet, found(bet))).toMatchObject({ failureCode: FailureCode.ReversalAmountMismatch });
    expect(settle(ofWin, wallet, found(win))).toMatchObject({ failureCode: FailureCode.InvalidReferenceKind });
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits the stake back", () => {
    const wallet = openWallet("90.00");
    const bet = processed(wallet, WagerTransactionKind.Bet, "10.00", "bet-1");
    const rollback = transactionFor(wallet, {
      kind: WagerTransactionKind.Rollback,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-1",
    });
    settle(rollback, wallet, found(bet));
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("of a WIN debits it and rejects with a distinct code when funds are missing", () => {
    const rich = openWallet("50.00");
    const win = processed(rich, WagerTransactionKind.Win, "30.00", "win-1");
    const rollback = transactionFor(rich, {
      kind: WagerTransactionKind.Rollback,
      money: brl("30.00"),
      referenceExternalTransactionId: "win-1",
    });
    settle(rollback, rich, found(win));
    expect(rich.balance.amount).toBe("20.00");

    const poor = openWallet("10.00");
    const bigWin = processed(poor, WagerTransactionKind.Win, "30.00", "win-2");
    const impossible = transactionFor(poor, {
      kind: WagerTransactionKind.Rollback,
      money: brl("30.00"),
      referenceExternalTransactionId: "win-2",
    });
    expect(settle(impossible, poor, found(bigWin))).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(poor.balance.amount).toBe("10.00");
  });

  test("of a REFUND debits the refunded amount", () => {
    const wallet = openWallet("100.00");
    const refund = processed(wallet, WagerTransactionKind.Refund, "10.00", "refund-1");
    const rollback = transactionFor(wallet, {
      kind: WagerTransactionKind.Rollback,
      money: brl("10.00"),
      referenceExternalTransactionId: "refund-1",
    });
    settle(rollback, wallet, found(refund));
    expect(wallet.balance.amount).toBe("90.00");
  });
});

describe("references", () => {
  test("a missing reference waits with backoff and is rejected once the budget is exhausted", () => {
    const wallet = openWallet("100.00");
    const refund = transactionFor(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet-late",
    });
    expect(settle(refund, wallet, { type: "missing" })).toEqual({
      status: WagerTransactionStatus.PendingReference,
      firstAttempt: true,
    });
    expect(settle(refund, wallet, { type: "missing" })).toEqual({
      status: WagerTransactionStatus.PendingReference,
      firstAttempt: false,
    });
    expect(settle(refund, wallet, { type: "missing" })).toEqual({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("a reference that is still pending makes the reversal wait", () => {
    const wallet = openWallet("100.00");
    const pendingRefund = transactionFor(wallet, {
      kind: WagerTransactionKind.Refund,
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-x",
    });
    pendingRefund.markPendingReference(retryPolicy, AT, wallet.balance);
    const rollback = transactionFor(wallet, {
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "refund-1",
    });
    expect(settle(rollback, wallet, found(pendingRefund)).status).toBe(WagerTransactionStatus.PendingReference);
  });

  test("references from another round or player are rejected", () => {
    const wallet = openWallet("90.00");
    const bet = processed(wallet, WagerTransactionKind.Bet, "10.00", "bet-1");
    const otherRound = transactionFor(wallet, {
      kind: WagerTransactionKind.Refund,
      roundId: "round-2",
      referenceExternalTransactionId: "bet-1",
    });
    expect(settle(otherRound, wallet, found(bet))).toMatchObject({ failureCode: FailureCode.ReferenceMismatch });
  });

  test("a rejected reference cannot be reversed", () => {
    const wallet = openWallet("90.00");
    const bet = transactionFor(wallet, { externalTransactionId: "bet-1" });
    bet.reject(FailureCode.InsufficientFunds, AT, wallet.balance);
    const refund = transactionFor(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-1" });
    expect(settle(refund, wallet, found(bet))).toMatchObject({ failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe("wallet guards", () => {
  test("currency conflicts are rejected and do not leak the balance", () => {
    const wallet = openWallet("100.00");
    const bet = transactionFor(wallet, { money: Money.from({ amount: "1.00", currency: "USD" }) });
    expect(settle(bet, wallet)).toMatchObject({ failureCode: FailureCode.CurrencyMismatch });
    expect(bet.observedBalance).toBeUndefined();
  });

  test("a wallet owned by another player is rejected", () => {
    const wallet = openWallet("100.00");
    const bet = transactionFor(wallet, { playerId: randomUUID() });
    expect(settle(bet, wallet)).toMatchObject({ failureCode: FailureCode.PlayerWalletMismatch });
    expect(wallet.balance.amount).toBe("100.00");
  });
});
