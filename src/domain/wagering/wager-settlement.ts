import { LedgerDirection } from "../ledger/ledger-direction";
import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { Wallet, WalletMovement } from "../wallet/wallet";
import { FailureCode } from "./failure-code";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import type { WagerTransaction } from "./wager-transaction";
import { WagerTransactionStatus } from "./wager-transaction-status";

export type ReferenceResolution =
  | { readonly type: "none" }
  | { readonly type: "missing" }
  | { readonly type: "found"; readonly transaction: WagerTransaction; readonly alreadyReversed: boolean };

export interface SettlementRequest {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: ReferenceResolution;
  retryPolicy: ReferenceRetryPolicy;
  ledgerEntryId: string;
  at: Date;
}

export type SettlementOutcome =
  | { readonly status: WagerTransactionStatus.Processed; readonly entry?: WalletLedgerEntry }
  | { readonly status: WagerTransactionStatus.Rejected; readonly failureCode: FailureCode }
  | { readonly status: WagerTransactionStatus.PendingReference; readonly firstAttempt: boolean };

type ReferenceDecision =
  | { readonly decision: "proceed"; readonly reference?: WagerTransaction }
  | { readonly decision: "wait"; readonly exhaustedCode: FailureCode }
  | { readonly decision: "reject"; readonly code: FailureCode };

export class WagerSettlement {
  settle(request: SettlementRequest): SettlementOutcome {
    const { transaction, wallet } = request;
    if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
      return this.reject(request, FailureCode.PlayerWalletMismatch, false);
    }
    if (transaction.money.currency !== wallet.currency) {
      return this.reject(request, FailureCode.CurrencyMismatch, false);
    }
    const decision = this.evaluateReference(request);
    switch (decision.decision) {
      case "wait":
        return this.awaitReference(request, decision.exhaustedCode);
      case "reject":
        return this.reject(request, decision.code, true);
      case "proceed":
        return this.apply(request, decision.reference);
    }
  }

  private evaluateReference(request: SettlementRequest): ReferenceDecision {
    const { transaction, reference } = request;
    if (reference.type === "none") {
      return { decision: "proceed" };
    }
    if (reference.type === "missing") {
      return { decision: "wait", exhaustedCode: FailureCode.ReferenceNotFound };
    }
    const target = reference.transaction;
    const sameContext =
      target.providerId === transaction.providerId &&
      target.playerId === transaction.playerId &&
      target.walletId === transaction.walletId &&
      target.roundId === transaction.roundId &&
      target.money.currency === transaction.money.currency;
    if (!sameContext) {
      return { decision: "reject", code: FailureCode.ReferenceMismatch };
    }
    if (!transaction.canReference(target.kind)) {
      return { decision: "reject", code: FailureCode.InvalidReferenceKind };
    }
    if (target.status === WagerTransactionStatus.Pending || target.status === WagerTransactionStatus.PendingReference) {
      return { decision: "wait", exhaustedCode: FailureCode.ReferenceNotProcessed };
    }
    if (target.status !== WagerTransactionStatus.Processed) {
      return { decision: "reject", code: FailureCode.ReferenceNotProcessed };
    }
    if (transaction.isReversal()) {
      if (!target.money.equals(transaction.money)) {
        return { decision: "reject", code: FailureCode.ReversalAmountMismatch };
      }
      if (reference.alreadyReversed) {
        return { decision: "reject", code: FailureCode.AlreadyReversed };
      }
    }
    return { decision: "proceed", reference: target };
  }

  private apply(request: SettlementRequest, reference: WagerTransaction | undefined): SettlementOutcome {
    const { transaction, wallet, at } = request;
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, at, wallet.balance);
      return { status: WagerTransactionStatus.Processed };
    }
    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      const code = transaction.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      return this.reject(request, code, true);
    }
    const movement: WalletMovement = {
      entryId: request.ledgerEntryId,
      transactionId: transaction.id,
      money: transaction.money,
      at,
    };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    transaction.markProcessed(reference?.id, at, wallet.balance);
    return { status: WagerTransactionStatus.Processed, entry };
  }

  private awaitReference(request: SettlementRequest, exhaustedCode: FailureCode): SettlementOutcome {
    const { transaction, retryPolicy, wallet, at } = request;
    if (retryPolicy.isExhausted(transaction.referenceAttempts + 1)) {
      return this.reject(request, exhaustedCode, true);
    }
    const firstAttempt = transaction.status === WagerTransactionStatus.Pending;
    transaction.markPendingReference(retryPolicy, at, wallet.balance);
    return { status: WagerTransactionStatus.PendingReference, firstAttempt };
  }

  private reject(request: SettlementRequest, code: FailureCode, exposeBalance: boolean): SettlementOutcome {
    request.transaction.reject(code, request.at, exposeBalance ? request.wallet.balance : undefined);
    return { status: WagerTransactionStatus.Rejected, failureCode: code };
  }
}
