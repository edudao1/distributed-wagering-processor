import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { EventContext, IntegrationEvent } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/wagering/events";
import type { SettlementOutcome } from "../../domain/wagering/wager-settlement";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import type { IdGenerator, WageringMetrics } from "../ports/infrastructure";
import type { TransactionScope } from "../ports/persistence";

export interface SettlementRecord {
  transaction: WagerTransaction;
  wallet: Wallet;
  outcome: SettlementOutcome;
  correlationId: string;
  causationId?: string;
  at: Date;
}

export class SettlementRecorder {
  constructor(
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
  ) {}

  record(scope: TransactionScope, record: SettlementRecord): void {
    const entries = scope.wallets.save(record.wallet);
    scope.transactions.save(record.transaction);
    for (const event of this.eventsFor(record, entries)) {
      scope.outbox.add(OutboxMessage.enqueue(event));
    }
    this.metrics.transactionSettled(record.transaction.kind, record.transaction.status);
  }

  private eventsFor(record: SettlementRecord, entries: WalletLedgerEntry[]): IntegrationEvent<unknown>[] {
    const { transaction, wallet, outcome } = record;
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: record.correlationId,
      causationId: record.causationId,
      occurredAt: record.at,
    });
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        return [
          WagerTransactionProcessed.from(transaction, context()),
          ...entries.map((entry) => WalletBalanceChanged.from(wallet, entry, context())),
        ];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, context())];
      case WagerTransactionStatus.PendingReference:
        return outcome.firstAttempt ? [WagerTransactionPendingReference.from(transaction, context())] : [];
    }
  }
}
