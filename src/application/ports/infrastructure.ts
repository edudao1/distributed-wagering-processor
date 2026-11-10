import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface PayloadHasher {
  hash(payload: unknown): string;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  child(bindings: LogFields): Logger;
}

export type RetryComponent = "sqs" | "outbox" | "pending_reference" | "write_conflict";
export type LockConflictType = "lock_timeout" | "deadlock" | "unique_race";

export interface WageringMetrics {
  transactionSettled(kind: string, status: string): void;
  duplicateDetected(source: "inbox" | "idempotency_key"): void;
  idempotencyConflict(reason: string): void;
  retryScheduled(component: RetryComponent): void;
  messageDeadLettered(reason: string): void;
  lockConflict(type: LockConflictType): void;
  processingObserved(source: string, outcome: string, seconds: number): void;
  outboxPublished(count: number): void;
  outboxBacklog(lagSeconds: number, pending: number): void;
  reconciliationChecked(consistent: boolean): void;
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
