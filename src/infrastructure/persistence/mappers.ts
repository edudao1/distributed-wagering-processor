import { LedgerDirection } from "../../domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import type { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import type { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import { Wallet, type WalletState } from "../../domain/wallet/wallet";
import {
  LedgerEntryRecord,
  OutboxRecord,
  type WagerTransactionRecord,
  type WalletRecord,
} from "./records";

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.rehydrate({ amount: record.balanceAmount, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function writeWalletRecord(record: WalletRecord, state: WalletState): void {
  record.id = state.id;
  record.playerId = state.playerId;
  record.currency = state.currency;
  record.balanceAmount = state.balance.amount;
  record.version = state.version;
  record.createdAt = state.createdAt;
  record.updatedAt = state.updatedAt;
}

export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.rehydrate({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance:
      record.observedBalanceAmount === null
        ? undefined
        : Money.rehydrate({ amount: record.observedBalanceAmount, currency: record.currency }),
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
  });
}

export function writeWagerTransactionRecord(record: WagerTransactionRecord, transaction: WagerTransaction, now: Date): void {
  const state = transaction.toState();
  record.id = state.id;
  record.providerId = state.providerId;
  record.externalTransactionId = state.externalTransactionId;
  record.idempotencyKey = state.idempotencyKey;
  record.payloadHash = state.payloadHash;
  record.walletId = state.walletId;
  record.playerId = state.playerId;
  record.roundId = state.roundId;
  record.gameId = state.gameId;
  record.kind = state.kind;
  record.amount = state.money.amount;
  record.currency = state.money.currency;
  record.referenceExternalTransactionId = state.referenceExternalTransactionId ?? null;
  record.referenceTransactionId = state.referenceTransactionId ?? null;
  record.status = state.status;
  record.failureCode = state.failureCode ?? null;
  record.observedBalanceAmount = state.observedBalance?.amount ?? null;
  record.referenceAttempts = state.referenceAttempts;
  record.nextReferenceAttemptAt = state.nextReferenceAttemptAt ?? null;
  record.createdAt = state.createdAt;
  record.processedAt = state.processedAt ?? null;
  record.updatedAt = now;
}

export function toLedgerEntryRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  const record = new LedgerEntryRecord();
  record.id = entry.id;
  record.walletId = entry.walletId;
  record.transactionId = entry.transactionId;
  record.direction = entry.direction;
  record.amount = entry.money.amount;
  record.currency = entry.money.currency;
  record.balanceBefore = entry.balanceBefore.amount;
  record.balanceAfter = entry.balanceAfter.amount;
  record.createdAt = entry.createdAt;
  return record;
}

export interface LedgerEntryRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

export function ledgerEntryFromRow(row: LedgerEntryRow): WalletLedgerEntry {
  const money = (amount: string): Money => Money.rehydrate({ amount, currency: row.currency });
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction === LedgerDirection.Credit ? LedgerDirection.Credit : LedgerDirection.Debit,
    money: money(row.amount),
    balanceBefore: money(row.balance_before),
    balanceAfter: money(row.balance_after),
    createdAt: new Date(row.created_at),
  });
}

export function toOutboxRecord(message: OutboxMessage): OutboxRecord {
  const record = new OutboxRecord();
  record.id = message.id;
  record.aggregateId = message.aggregateId;
  record.eventType = message.eventType;
  record.payload = { ...message.payload };
  record.occurredAt = message.occurredAt;
  record.attempts = message.attempts;
  record.nextAttemptAt = message.nextAttemptAt ?? message.occurredAt;
  record.publishedAt = message.publishedAt ?? null;
  return record;
}

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

export function outboxMessageFromRow(row: OutboxRow): OutboxMessage {
  const payload = typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload;
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: Object.freeze(payload),
    occurredAt: new Date(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? undefined : new Date(row.next_attempt_at),
    publishedAt: row.published_at === null ? undefined : new Date(row.published_at),
  });
}
