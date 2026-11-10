import { LockMode, QueryOrder } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  DuePendingReference,
  InboxRecordResult,
  InboxRepository,
  LedgerPage,
  LedgerReader,
  LedgerSummary,
  OutboxRepository,
  TransactionScope,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports/persistence";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import {
  ledgerEntryFromRow,
  type LedgerEntryRow,
  toLedgerEntryRecord,
  toOutboxRecord,
  toWagerTransaction,
  toWallet,
  writeWagerTransactionRecord,
  writeWalletRecord,
} from "./mappers";
import { WagerTransactionRecord, WalletRecord } from "./records";
import { query } from "./sql";

class MikroOrmWalletRepository implements WalletRepository {
  private readonly tracked = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? this.track(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? this.track(record) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record ? this.track(record) : undefined;
  }

  save(wallet: Wallet): WalletLedgerEntry[] {
    const state = wallet.toState();
    const existing = this.tracked.get(wallet.id);
    if (existing) {
      writeWalletRecord(existing, state);
    } else {
      const record = new WalletRecord();
      writeWalletRecord(record, state);
      this.em.persist(record);
      this.tracked.set(wallet.id, record);
    }
    const entries = wallet.pullUncommittedEntries();
    for (const entry of entries) {
      this.em.persist(toLedgerEntryRecord(entry));
    }
    return entries;
  }

  private track(record: WalletRecord): Wallet {
    this.tracked.set(record.id, record);
    return toWallet(record);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly tracked = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.load(await this.em.findOne(WagerTransactionRecord, { id }, { refresh: true }));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.load(await this.em.findOne(WagerTransactionRecord, { idempotencyKey }, { refresh: true }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.load(
      await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, { refresh: true }),
    );
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findDueForReferenceRetry(now: Date, limit: number): Promise<DuePendingReference[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: QueryOrder.ASC }, limit },
    );
    return records.map((record) => ({ transactionId: record.id, walletId: record.walletId }));
  }

  save(transaction: WagerTransaction): void {
    const now = new Date();
    const existing = this.tracked.get(transaction.id);
    if (existing) {
      writeWagerTransactionRecord(existing, transaction, now);
      return;
    }
    const record = new WagerTransactionRecord();
    writeWagerTransactionRecord(record, transaction, now);
    this.em.persist(record);
    this.tracked.set(transaction.id, record);
  }

  private load(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (!record) {
      return undefined;
    }
    this.tracked.set(record.id, record);
    return toWagerTransaction(record);
  }
}

interface LedgerSummaryRow {
  credits: string;
  debits: string;
  entries: number | string;
  last_balance_after: string | null;
}

class SqlLedgerReader implements LedgerReader {
  constructor(private readonly em: EntityManager) {}

  async page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage> {
    const rows = await query<LedgerEntryRow>(
      this.em,
      `select seq::text as seq, id, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?::bigint
        order by seq asc
        limit ?::int`,
      [walletId, afterSequence ?? "0", limit + 1],
    );
    const visible = rows.slice(0, limit);
    return {
      entries: visible.map((row) => ({ sequence: row.seq, entry: ledgerEntryFromRow(row) })),
      hasMore: rows.length > limit,
    };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await query<LedgerSummaryRow>(
      this.em,
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::text as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::text as debits,
              count(*)::int as entries,
              (select balance_after::text from wallet_ledger_entries
                where wallet_id = ? order by seq desc limit 1) as last_balance_after
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId, walletId],
    );
    const money = (amount: string): Money => Money.rehydrate({ amount: normalizeAmount(amount), currency });
    return {
      credits: money(row?.credits ?? "0"),
      debits: money(row?.debits ?? "0"),
      entries: Number(row?.entries ?? 0),
      lastBalanceAfter: row?.last_balance_after ? money(row.last_balance_after) : undefined,
    };
  }
}

function normalizeAmount(amount: string): string {
  const [integer, fraction = ""] = amount.split(".");
  return fraction.length > 2 ? `${integer}.${fraction.slice(0, 2)}` : amount;
}

interface InboxRow {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: Date | string;
  processed_at: Date | string | null;
}

class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async record(message: InboxMessage): Promise<InboxRecordResult> {
    const inserted = await query<{ message_id: string }>(
      this.em,
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    if (inserted.length > 0) {
      return { recorded: true };
    }
    const [row] = await query<InboxRow>(
      this.em,
      `select consumer_name, message_id, payload_hash, received_at, processed_at
         from inbox_messages
        where consumer_name = ? and message_id = ?`,
      [message.consumerName, message.messageId],
    );
    if (!row) {
      throw new Error(`inbox message ${message.messageId} conflicted but could not be read`);
    }
    return {
      recorded: false,
      existing: InboxMessage.rehydrate({
        consumerName: row.consumer_name,
        messageId: row.message_id,
        payloadHash: row.payload_hash,
        receivedAt: new Date(row.received_at),
        processedAt: row.processed_at === null ? undefined : new Date(row.processed_at),
      }),
    };
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(toOutboxRecord(message));
  }
}

export class MikroOrmTransactionScope implements TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerReader;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new SqlLedgerReader(em);
    this.inbox = new SqlInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}
