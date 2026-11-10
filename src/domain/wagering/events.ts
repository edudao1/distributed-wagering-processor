import { InvalidTransactionStateError } from "../errors";
import type { LedgerDirection } from "../ledger/ledger-direction";
import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from "../messaging/integration-event";
import type { MoneyProps } from "../money/money";
import type { Wallet } from "../wallet/wallet";
import type { FailureCode } from "./failure-code";
import type { WagerTransaction } from "./wager-transaction";
import type { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

export interface WagerTransactionSnapshot {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionSnapshot {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionSnapshot {
  failureCode: FailureCode;
  rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionSnapshot {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

function snapshotOf(transaction: WagerTransaction): WagerTransactionSnapshot {
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
    ...(transaction.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
  };
}

function requireStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new InvalidTransactionStateError(`transaction ${transaction.id} is ${transaction.status}, expected ${expected}`);
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    requireStatus(transaction, WagerTransactionStatus.Processed);
    const { processedAt, observedBalance } = transaction;
    if (!processedAt || !observedBalance) {
      throw new InvalidTransactionStateError(`processed transaction ${transaction.id} is missing its outcome`);
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...snapshotOf(transaction),
        ...(transaction.referenceTransactionId !== undefined
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
        balance: observedBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    requireStatus(transaction, WagerTransactionStatus.Rejected);
    const { failureCode, processedAt } = transaction;
    if (!failureCode || !processedAt) {
      throw new InvalidTransactionStateError(`rejected transaction ${transaction.id} is missing its failure code`);
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.walletId,
      data: { ...snapshotOf(transaction), failureCode, rejectedAt: processedAt.toISOString() },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    requireStatus(transaction, WagerTransactionStatus.PendingReference);
    const { referenceExternalTransactionId, nextReferenceAttemptAt } = transaction;
    if (referenceExternalTransactionId === undefined || !nextReferenceAttemptAt) {
      throw new InvalidTransactionStateError(`pending transaction ${transaction.id} is missing its reference schedule`);
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...snapshotOf(transaction),
        referenceExternalTransactionId,
        attempts: transaction.referenceAttempts,
        nextAttemptAt: nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
