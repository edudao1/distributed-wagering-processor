import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { AT, brl, openWallet, retryPolicy, transactionFor } from "../support/builders";

const wallet = openWallet("100.00");

describe("WagerTransaction", () => {
  test("is born PENDING", () => {
    const transaction = transactionFor(wallet);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
  });

  test("OPENING cannot be created through the public factory", () => {
    expect(() => transactionFor(wallet, { kind: WagerTransactionKind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test("the internal provider id is reserved", () => {
    expect(() => transactionFor(wallet, { providerId: "internal" })).toThrow(InvalidWagerTransactionError);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])("%s requires a reference", (kind) => {
    expect(() => transactionFor(wallet, { kind })).toThrow(InvalidWagerTransactionError);
  });

  test("BET does not accept a reference and nothing references itself", () => {
    expect(() => transactionFor(wallet, { referenceExternalTransactionId: "x" })).toThrow(InvalidWagerTransactionError);
    expect(() =>
      transactionFor(wallet, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: "same",
        referenceExternalTransactionId: "same",
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("balance-moving kinds need a positive amount, LOSS may be zero", () => {
    expect(() => transactionFor(wallet, { money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
    expect(transactionFor(wallet, { kind: WagerTransactionKind.Loss, money: brl("0.00") }).affectsBalance()).toBe(false);
  });

  test("terminal states never transition again", () => {
    const processed = transactionFor(wallet);
    processed.markProcessed(undefined, AT, brl("90.00"));
    expect(processed.isTerminal()).toBe(true);
    expect(() => processed.markProcessed(undefined, AT, brl("90.00"))).toThrow(InvalidTransactionStateError);
    expect(() => processed.reject(FailureCode.InsufficientFunds, AT)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markPendingReference(retryPolicy, AT, brl("1.00"))).toThrow(InvalidTransactionStateError);

    const rejected = transactionFor(wallet);
    rejected.reject(FailureCode.InsufficientFunds, AT, brl("1.00"));
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => rejected.fail(FailureCode.ProcessingFailed, AT)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING_REFERENCE re-schedules with exponential backoff", () => {
    const refund = transactionFor(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-1" });
    refund.markPendingReference(retryPolicy, AT, brl("100.00"));
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(AT.getTime() + 1_000);
    refund.markPendingReference(retryPolicy, AT, brl("100.00"));
    expect(refund.referenceAttempts).toBe(2);
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(AT.getTime() + 2_000);
    expect(refund.isDueForReferenceRetry(AT)).toBe(false);
    expect(refund.isDueForReferenceRetry(new Date(AT.getTime() + 2_000))).toBe(true);
  });

  test("ledger direction follows the kind, ROLLBACK inverts its reference", () => {
    const bet = transactionFor(wallet);
    const win = transactionFor(wallet, { kind: WagerTransactionKind.Win });
    const refund = transactionFor(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "b" });
    const rollback = transactionFor(wallet, { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "b" });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => transactionFor(wallet, { kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("allowed references per kind", () => {
    const refund = transactionFor(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "b" });
    const rollback = transactionFor(wallet, { kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "b" });
    expect(refund.canReference(WagerTransactionKind.Bet)).toBe(true);
    expect(refund.canReference(WagerTransactionKind.Win)).toBe(false);
    expect(rollback.canReference(WagerTransactionKind.Win)).toBe(true);
    expect(rollback.canReference(WagerTransactionKind.Refund)).toBe(true);
    expect(rollback.canReference(WagerTransactionKind.Rollback)).toBe(false);
    expect(rollback.canReference(WagerTransactionKind.Loss)).toBe(false);
  });

  test("payload comparison drives idempotency", () => {
    const transaction = transactionFor(wallet);
    expect(transaction.matchesPayload("a".repeat(64))).toBe(true);
    expect(transaction.matchesPayload("b".repeat(64))).toBe(false);
  });
});
