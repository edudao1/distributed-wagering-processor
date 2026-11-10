import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { LockConflictType, RetryComponent, WageringMetrics } from "../../application/ports/infrastructure";

export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions settled, by kind and resulting status",
    labelNames: ["kind", "status"],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Duplicate deliveries detected by the inbox or by the idempotency key",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly idempotencyConflicts = new Counter({
    name: "wagering_idempotency_conflicts_total",
    help: "Idempotency keys reused with a different payload",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retries scheduled, by component",
    labelNames: ["component"],
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: "wagering_dlq_messages_total",
    help: "Messages sent to the dead-letter queue",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Concurrency conflicts observed in the database",
    labelNames: ["type"],
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of wager transactions",
    labelNames: ["source", "outcome"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly published = new Counter({
    name: "wagering_outbox_published_total",
    help: "Outbox events published to the broker",
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox event",
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: "wagering_outbox_pending",
    help: "Number of unpublished outbox events",
    registers: [this.registry],
  });

  private readonly reconciliations = new Counter({
    name: "wagering_reconciliations_total",
    help: "Wallet reconciliations executed, by result",
    labelNames: ["result"],
    registers: [this.registry],
  });

  transactionSettled(kind: string, status: string): void {
    this.transactions.inc({ kind, status });
  }

  duplicateDetected(source: "inbox" | "idempotency_key"): void {
    this.duplicates.inc({ source });
  }

  idempotencyConflict(reason: string): void {
    this.idempotencyConflicts.inc({ reason });
  }

  retryScheduled(component: RetryComponent): void {
    this.retries.inc({ component });
  }

  messageDeadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  lockConflict(type: LockConflictType): void {
    this.lockConflicts.inc({ type });
  }

  processingObserved(source: string, outcome: string, seconds: number): void {
    this.processingDuration.observe({ source, outcome }, seconds);
  }

  outboxPublished(count: number): void {
    this.published.inc(count);
  }

  outboxBacklog(lagSeconds: number, pending: number): void {
    this.outboxLag.set(lagSeconds);
    this.outboxPending.set(pending);
  }

  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? "consistent" : "divergent" });
  }
}
