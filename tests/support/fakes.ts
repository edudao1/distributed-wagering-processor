import type {
  Clock,
  IdGenerator,
  LogFields,
  Logger,
  WageringMetrics,
} from "../../src/application/ports/infrastructure";
import { UuidV7Generator } from "../../src/infrastructure/system/system-adapters";

export class FixedClock implements Clock {
  constructor(private current = new Date("2026-07-29T15:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export const ids: IdGenerator = new UuidV7Generator();

export class SilentLogger implements Logger {
  debug(_fields: LogFields, _message: string): void {}
  info(_fields: LogFields, _message: string): void {}
  warn(_fields: LogFields, _message: string): void {}
  error(_fields: LogFields, _message: string): void {}
  child(_bindings: LogFields): Logger {
    return this;
  }
}

export class RecordingMetrics implements WageringMetrics {
  readonly calls: Array<{ name: string; args: unknown[] }> = [];

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  transactionSettled(...args: unknown[]): void {
    this.calls.push({ name: "transactionSettled", args });
  }

  duplicateDetected(...args: unknown[]): void {
    this.calls.push({ name: "duplicateDetected", args });
  }

  idempotencyConflict(...args: unknown[]): void {
    this.calls.push({ name: "idempotencyConflict", args });
  }

  retryScheduled(...args: unknown[]): void {
    this.calls.push({ name: "retryScheduled", args });
  }

  messageDeadLettered(...args: unknown[]): void {
    this.calls.push({ name: "messageDeadLettered", args });
  }

  lockConflict(...args: unknown[]): void {
    this.calls.push({ name: "lockConflict", args });
  }

  processingObserved(...args: unknown[]): void {
    this.calls.push({ name: "processingObserved", args });
  }

  outboxPublished(...args: unknown[]): void {
    this.calls.push({ name: "outboxPublished", args });
  }

  outboxBacklog(...args: unknown[]): void {
    this.calls.push({ name: "outboxBacklog", args });
  }

  reconciliationChecked(...args: unknown[]): void {
    this.calls.push({ name: "reconciliationChecked", args });
  }
}
