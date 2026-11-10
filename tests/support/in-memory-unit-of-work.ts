import type {
  DuePendingReference,
  InboxRecordResult,
  LedgerPage,
  LedgerSummary,
  TransactionScope,
  UnitOfWork,
} from "../../src/application/ports/persistence";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import type { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../src/domain/messaging/inbox-message";
import type { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/money/money";
import { WagerTransaction, type WagerTransactionState } from "../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { Wallet, type WalletState } from "../../src/domain/wallet/wallet";

export class InMemoryStore {
  readonly wallets = new Map<string, WalletState>();
  readonly transactions = new Map<string, WagerTransactionState>();
  readonly ledger: WalletLedgerEntry[] = [];
  readonly inbox = new Map<string, InboxMessage>();
  readonly outbox: OutboxMessage[] = [];
}

class InMemoryScope implements TransactionScope {
  private readonly stagedWallets: WalletState[] = [];
  private readonly stagedTransactions: WagerTransactionState[] = [];
  private readonly stagedEntries: WalletLedgerEntry[] = [];
  private readonly stagedInbox: InboxMessage[] = [];
  private readonly stagedOutbox: OutboxMessage[] = [];

  constructor(private readonly store: InMemoryStore) {}

  readonly wallets = {
    findById: async (id: string) => this.wallet(id),
    findByIdForUpdate: async (id: string) => this.wallet(id),
    findByPlayerAndCurrency: async (playerId: string, currency: string) => {
      const state = [...this.store.wallets.values()].find(
        (wallet) => wallet.playerId === playerId && wallet.currency === currency,
      );
      return state ? Wallet.rehydrate(state) : undefined;
    },
    save: (wallet: Wallet) => {
      this.stagedWallets.push(wallet.toState());
      const entries = wallet.pullUncommittedEntries();
      this.stagedEntries.push(...entries);
      return entries;
    },
  };

  readonly transactions = {
    findById: async (id: string) => this.transaction((state) => state.id === id),
    findByIdempotencyKey: async (key: string) => this.transaction((state) => state.idempotencyKey === key),
    findByExternalId: async (providerId: string, externalId: string) =>
      this.transaction((state) => state.providerId === providerId && state.externalTransactionId === externalId),
    hasProcessedReversal: async (referenceTransactionId: string) =>
      [...this.store.transactions.values()].some(
        (state) =>
          state.referenceTransactionId === referenceTransactionId &&
          state.status === WagerTransactionStatus.Processed &&
          (state.kind === WagerTransactionKind.Refund || state.kind === WagerTransactionKind.Rollback),
      ),
    findDueForReferenceRetry: async (now: Date, limit: number): Promise<DuePendingReference[]> =>
      [...this.store.transactions.values()]
        .filter(
          (state) =>
            state.status === WagerTransactionStatus.PendingReference &&
            (state.nextReferenceAttemptAt?.getTime() ?? 0) <= now.getTime(),
        )
        .slice(0, limit)
        .map((state) => ({ transactionId: state.id, walletId: state.walletId })),
    save: (transaction: WagerTransaction) => {
      this.stagedTransactions.push(transaction.toState());
    },
  };

  readonly ledger = {
    page: async (walletId: string, _after: string | undefined, limit: number): Promise<LedgerPage> => {
      const entries = this.store.ledger.filter((entry) => entry.walletId === walletId);
      return {
        entries: entries.slice(0, limit).map((entry, index) => ({ sequence: String(index + 1), entry })),
        hasMore: entries.length > limit,
      };
    },
    summarize: async (walletId: string, currency: string): Promise<LedgerSummary> => {
      const entries = this.store.ledger.filter((entry) => entry.walletId === walletId);
      const sum = (direction: LedgerDirection): Money =>
        entries
          .filter((entry) => entry.direction === direction)
          .reduce((total, entry) => total.add(entry.money), Money.zero(currency));
      return {
        credits: sum(LedgerDirection.Credit),
        debits: sum(LedgerDirection.Debit),
        entries: entries.length,
        lastBalanceAfter: entries.at(-1)?.balanceAfter,
      };
    },
  };

  readonly inbox = {
    record: async (message: InboxMessage): Promise<InboxRecordResult> => {
      const key = `${message.consumerName}:${message.messageId}`;
      const existing = this.store.inbox.get(key);
      if (existing) {
        return { recorded: false, existing };
      }
      this.stagedInbox.push(message);
      return { recorded: true };
    },
  };

  readonly outbox = {
    add: (message: OutboxMessage) => {
      this.stagedOutbox.push(message);
    },
  };

  commit(): void {
    for (const state of this.stagedWallets) {
      this.store.wallets.set(state.id, state);
    }
    for (const state of this.stagedTransactions) {
      this.store.transactions.set(state.id, state);
    }
    this.store.ledger.push(...this.stagedEntries);
    for (const message of this.stagedInbox) {
      this.store.inbox.set(`${message.consumerName}:${message.messageId}`, message);
    }
    this.store.outbox.push(...this.stagedOutbox);
  }

  private wallet(id: string): Wallet | undefined {
    const state = this.store.wallets.get(id);
    return state ? Wallet.rehydrate(state) : undefined;
  }

  private transaction(predicate: (state: WagerTransactionState) => boolean): WagerTransaction | undefined {
    const state = [...this.store.transactions.values()].find(predicate);
    return state ? WagerTransaction.rehydrate(state) : undefined;
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  readonly store = new InMemoryStore();

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const scope = new InMemoryScope(this.store);
    const result = await work(scope);
    scope.commit();
    return result;
  }
}
