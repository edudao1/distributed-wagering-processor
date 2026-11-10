import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { IdempotencyConflictError } from "../../src/application/errors";
import { ProcessWagerTransaction } from "../../src/application/wagering/process-wager-transaction";
import { SettlementRecorder } from "../../src/application/wagering/settlement-recorder";
import type { WagerTransactionCommand } from "../../src/application/wagering/wager-transaction-command";
import { CreateWallet } from "../../src/application/wallets/create-wallet";
import { LedgerDirection } from "../../src/domain/ledger/ledger-direction";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import { canonicalJson } from "../../src/infrastructure/hashing/canonical-json";
import { Sha256PayloadHasher } from "../../src/infrastructure/hashing/sha256-payload-hasher";
import { retryPolicy } from "../support/builders";
import { FixedClock, ids, RecordingMetrics, SilentLogger } from "../support/fakes";
import { InMemoryUnitOfWork } from "../support/in-memory-unit-of-work";

const hasher = new Sha256PayloadHasher();

describe("payload hash", () => {
  test("is independent of key order and of the idempotency header", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hasher.hash({ a: 1, b: "x" })).toBe(hasher.hash({ b: "x", a: 1 }));
    expect(hasher.hash({ a: 1, skipped: undefined })).toBe(hasher.hash({ a: 1 }));
    expect(hasher.hash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

async function setup() {
  const uow = new InMemoryUnitOfWork();
  const metrics = new RecordingMetrics();
  const clock = new FixedClock();
  const logger = new SilentLogger();
  const createWallet = new CreateWallet(uow, hasher, clock, ids, metrics, logger);
  const process = new ProcessWagerTransaction(
    uow,
    hasher,
    clock,
    ids,
    new SettlementRecorder(ids, metrics),
    retryPolicy,
    metrics,
    logger,
  );
  const playerId = randomUUID();
  const wallet = await createWallet.execute(
    { playerId, initialBalance: { amount: "100.00", currency: "BRL" } },
    { correlationId: "test" },
  );
  const command: WagerTransactionCommand = {
    idempotencyKey: "provider-a:transaction-123",
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId,
    walletId: wallet.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
  };
  return { uow, metrics, process, command };
}

describe("idempotency", () => {
  test("an identical request replays the original response", async () => {
    const { uow, process, command, metrics } = await setup();
    const first = await process.execute(command, { correlationId: "c1" });
    const second = await process.execute({ ...command, money: { amount: "25", currency: "BRL" } }, { correlationId: "c2" });
    expect(first).toMatchObject({ outcome: "completed", view: { status: "PROCESSED", idempotentReplay: false } });
    expect(second).toMatchObject({ outcome: "completed", view: { status: "PROCESSED", idempotentReplay: true } });
    if (first.outcome === "completed" && second.outcome === "completed") {
      expect(second.view.transactionId).toBe(first.view.transactionId);
      expect(second.view.balance).toEqual({ amount: "75.00", currency: "BRL" });
    }
    const debits = uow.store.ledger.filter((entry) => entry.direction === LedgerDirection.Debit);
    expect(debits).toHaveLength(1);
    expect(metrics.count("duplicateDetected")).toBe(1);
  });

  test("the same key with a different payload is a conflict, not a replay", async () => {
    const { process, command } = await setup();
    await process.execute(command, { correlationId: "c1" });
    const conflicting = process.execute({ ...command, money: { amount: "26.00", currency: "BRL" } }, { correlationId: "c2" });
    await expect(conflicting).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(conflicting).rejects.toMatchObject({ reason: "PAYLOAD_MISMATCH" });
  });

  test("the same external id under another key is a conflict", async () => {
    const { process, command } = await setup();
    await process.execute(command, { correlationId: "c1" });
    const reused = process.execute({ ...command, idempotencyKey: "another-key" }, { correlationId: "c2" });
    await expect(reused).rejects.toMatchObject({ reason: "EXTERNAL_ID_REUSED" });
  });

  test("a replayed rejection keeps the balance observed at that moment", async () => {
    const { process, command } = await setup();
    const tooBig = { ...command, money: { amount: "500.00", currency: "BRL" } };
    const rejected = await process.execute(tooBig, { correlationId: "c1" });
    await process.execute(
      { ...command, idempotencyKey: "k2", externalTransactionId: "t2", money: { amount: "50.00", currency: "BRL" } },
      { correlationId: "c2" },
    );
    const replay = await process.execute(tooBig, { correlationId: "c3" });
    expect(rejected).toMatchObject({ view: { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" } });
    expect(replay).toMatchObject({
      view: { status: "REJECTED", idempotentReplay: true, balance: { amount: "100.00", currency: "BRL" } },
    });
  });

  test("duplicate inbox messages are acknowledged without side effects", async () => {
    const { uow, process, command } = await setup();
    const inbox = { consumerName: "wagering", messageId: "msg-1", payloadHash: hasher.hash(command) };
    const first = await process.execute(command, { correlationId: "c1", inbox });
    const again = await process.execute(command, { correlationId: "c1", inbox });
    expect(first.outcome).toBe("completed");
    expect(again.outcome).toBe("duplicate-message");
    expect(uow.store.ledger.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);
  });
});
