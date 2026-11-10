import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  save(wallet: Wallet): WalletLedgerEntry[];
}

export interface DuePendingReference {
  transactionId: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDueForReferenceRetry(now: Date, limit: number): Promise<DuePendingReference[]>;
  save(transaction: WagerTransaction): void;
}

export interface LedgerPage {
  entries: Array<{ sequence: string; entry: WalletLedgerEntry }>;
  hasMore: boolean;
}

export interface LedgerSummary {
  credits: Money;
  debits: Money;
  entries: number;
  lastBalanceAfter?: Money;
}

export interface LedgerReader {
  page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export type InboxRecordResult = { recorded: true } | { recorded: false; existing: InboxMessage };

export interface InboxRepository {
  record(message: InboxMessage): Promise<InboxRecordResult>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}

export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerReader;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  isolation?: "read-committed" | "repeatable-read";
  readOnly?: boolean;
}

export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

export interface OutboxBacklog {
  pending: number;
  lagSeconds: number;
}

export interface OutboxStore {
  claim(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  release(message: OutboxMessage, owner: string, error: string): Promise<void>;
  backlog(): Promise<OutboxBacklog>;
}
