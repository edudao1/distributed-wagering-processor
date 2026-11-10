import type { LedgerDirection } from "../domain/ledger/ledger-direction";
import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import type { MoneyProps } from "../domain/money/money";
import type { FailureCode } from "../domain/wagering/failure-code";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../domain/wagering/wager-transaction-kind";
import type { WagerTransactionStatus } from "../domain/wagering/wager-transaction-status";
import type { Wallet } from "../domain/wallet/wallet";

export interface WagerSubmissionView {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  referenceAttempts: number;
  nextReferenceAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function toSubmissionView(transaction: WagerTransaction, idempotentReplay: boolean): WagerSubmissionView {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode,
    balance: transaction.observedBalance?.toJSON(),
    idempotentReplay,
  };
}

export function toTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    balance: transaction.observedBalance?.toJSON(),
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt?.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString(),
  };
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}
