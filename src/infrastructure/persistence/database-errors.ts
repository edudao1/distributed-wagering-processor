import { ApplicationError, ConcurrentWriteConflictError, TransientInfrastructureError } from "../../application/errors";
import type { WageringMetrics } from "../../application/ports/infrastructure";
import { DomainError } from "../../domain/shared/domain-error";

const UNIQUE_VIOLATION = "23505";
const LOCK_TIMEOUT = "55P03";
const DEADLOCK_CODES = new Set(["40001", "40P01"]);
const TRANSIENT_SQL_STATES = new Set([
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "53400",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
const TRANSIENT_MESSAGES = [
  /timeout acquiring a connection/i,
  /connection terminated/i,
  /connection refused/i,
  /server closed the connection/i,
  /the database system is (starting up|shutting down)/i,
];

interface ErrorFacts {
  codes: string[];
  constraint?: string;
  messages: string[];
}

function collectFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = { codes: [], messages: [] };
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ["code", "sqlState", "errno"]) {
      const value = record[key];
      if (typeof value === "string") {
        facts.codes.push(value);
      }
    }
    if (typeof record.constraint === "string" && !facts.constraint) {
      facts.constraint = record.constraint;
    }
    if (typeof record.message === "string") {
      facts.messages.push(record.message);
    }
    queue.push(record.cause, record.previous, record.originalError);
  }
  if (!facts.constraint) {
    for (const message of facts.messages) {
      const match = /constraint "([^"]+)"/.exec(message);
      if (match?.[1]) {
        facts.constraint = match[1];
        break;
      }
    }
  }
  return facts;
}

export function translatePersistenceError(error: unknown, metrics?: WageringMetrics): Error {
  if (error instanceof DomainError || error instanceof ApplicationError) {
    return error;
  }
  const facts = collectFacts(error);
  const hasCode = (predicate: (code: string) => boolean): boolean => facts.codes.some(predicate);

  if (hasCode((code) => code === UNIQUE_VIOLATION)) {
    metrics?.lockConflict("unique_race");
    return new ConcurrentWriteConflictError(facts.constraint, error);
  }
  if (hasCode((code) => code === LOCK_TIMEOUT)) {
    metrics?.lockConflict("lock_timeout");
    return new TransientInfrastructureError("lock_timeout", error);
  }
  if (hasCode((code) => DEADLOCK_CODES.has(code))) {
    metrics?.lockConflict("deadlock");
    return new TransientInfrastructureError("deadlock_or_serialization", error);
  }
  if (
    hasCode((code) => TRANSIENT_SQL_STATES.has(code) || TRANSIENT_NETWORK_CODES.has(code)) ||
    facts.messages.some((message) => TRANSIENT_MESSAGES.some((pattern) => pattern.test(message)))
  ) {
    return new TransientInfrastructureError("database_unavailable", error);
  }
  return error instanceof Error ? error : new Error(String(error));
}
