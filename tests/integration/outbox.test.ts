import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { PublishOutboxBatch } from "../../src/application/messaging/publish-outbox";
import type { EventPublisher } from "../../src/application/ports/infrastructure";
import type { OutboxStore } from "../../src/application/ports/persistence";
import { EVENT_PUBLISHER, OUTBOX_STORE } from "../../src/application/ports/tokens";
import type { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { QueueUrlResolver, SQS_CLIENT } from "../../src/infrastructure/messaging/sqs-client";
import { SystemClock } from "../../src/infrastructure/system/system-adapters";
import { type TestApplication, startApplication } from "../support/application";
import { db } from "../support/database";
import { sleep, testConfig } from "../support/environment";
import { RecordingMetrics, SilentLogger } from "../support/fakes";
import { createWallet, submit, wagerPayload } from "../support/http";
import { drain } from "../support/sqs";

let application: TestApplication;
let store: OutboxStore;
let sqsPublisher: EventPublisher;
let sqs: SQSClient;
let eventsUrl: string;

beforeAll(async () => {
  application = await startApplication(testConfig());
  store = application.app.get<OutboxStore>(OUTBOX_STORE);
  sqsPublisher = application.app.get<EventPublisher>(EVENT_PUBLISHER);
  sqs = application.app.get<SQSClient>(SQS_CLIENT);
  eventsUrl = await application.app.get(QueueUrlResolver).resolve(application.config.sqs.eventsQueue);
  await db().query(`update outbox_messages set published_at = now(), locked_by = null, locked_until = null where published_at is null`);
});

afterAll(async () => {
  await application.close();
});

class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];

  async publish(message: OutboxMessage): Promise<void> {
    await sqsPublisher.publish(message);
    this.published.push(message.id);
  }
}

function publisherFor(owner: string, publisher: EventPublisher, leaseMs = 5_000, batchSize = 7): PublishOutboxBatch {
  return new PublishOutboxBatch(store, publisher, new SystemClock(), new RecordingMetrics(), new SilentLogger(), {
    owner,
    batchSize,
    leaseMs,
  });
}

async function seedEvents(wallets: number): Promise<{ walletIds: string[]; eventIds: string[] }> {
  const walletIds: string[] = [];
  for (let index = 0; index < wallets; index += 1) {
    const wallet = await createWallet(application.baseUrl, "100.00");
    await submit(application.baseUrl, wagerPayload(wallet));
    walletIds.push(wallet.id);
  }
  const { rows } = await db().query(`select id from outbox_messages where aggregate_id = any($1::text[])`, [walletIds]);
  return { walletIds, eventIds: rows.map((row) => row.id as string) };
}

async function unpublished(eventIds: string[]): Promise<number> {
  const { rows } = await db().query(
    `select count(*)::int as total from outbox_messages where id = any($1::uuid[]) and published_at is null`,
    [eventIds],
  );
  return rows[0]?.total ?? 0;
}

async function publishUntilEmpty(publisher: PublishOutboxBatch, eventIds: string[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while ((await unpublished(eventIds)) > 0 && Date.now() < deadline) {
    if ((await publisher.execute()) === 0) {
      await sleep(50);
    }
  }
}

describe("transactional outbox", () => {
  test("events stay in the outbox until a publisher sends them after the commit", async () => {
    const { eventIds } = await seedEvents(1);
    expect(eventIds).toHaveLength(4);
    expect(await unpublished(eventIds)).toBe(4);
    await publishUntilEmpty(publisherFor("solo", sqsPublisher), eventIds);
    expect(await unpublished(eventIds)).toBe(0);
    const received = await drain(sqs, eventsUrl, 4);
    const receivedIds = received.map((message) => JSON.parse(message.Body ?? "{}").eventId as string);
    for (const eventId of eventIds) {
      expect(receivedIds).toContain(eventId);
    }
  });

  test("two concurrent publishers never publish the same event twice", async () => {
    const { eventIds } = await seedEvents(10);
    const first = new RecordingPublisher();
    const second = new RecordingPublisher();
    await Promise.all([
      publishUntilEmpty(publisherFor("publisher-a", first), eventIds),
      publishUntilEmpty(publisherFor("publisher-b", second), eventIds),
    ]);
    const ours = new Set(eventIds);
    const firstOurs = first.published.filter((id) => ours.has(id));
    const secondOurs = second.published.filter((id) => ours.has(id));
    expect(firstOurs.length + secondOurs.length).toBe(eventIds.length);
    expect(new Set([...firstOurs, ...secondOurs]).size).toBe(eventIds.length);
    expect(firstOurs.length).toBeGreaterThan(0);
    expect(secondOurs.length).toBeGreaterThan(0);
    expect(await unpublished(eventIds)).toBe(0);
  });

  test("a publisher that dies after claiming is replaced once its lease expires", async () => {
    const { eventIds } = await seedEvents(1);
    await db().query(`update outbox_messages set locked_by = 'dead-instance', locked_until = now() + interval '700 milliseconds' where id = any($1::uuid[])`, [eventIds]);
    const survivor = new RecordingPublisher();
    const replacement = publisherFor("survivor", survivor);
    await replacement.execute();
    expect(survivor.published.filter((id) => eventIds.includes(id))).toHaveLength(0);
    await sleep(800);
    await publishUntilEmpty(replacement, eventIds);
    expect(survivor.published.filter((id) => eventIds.includes(id)).sort()).toEqual([...eventIds].sort());
  });

  test("a failed publication is retried with backoff instead of being lost", async () => {
    const { eventIds } = await seedEvents(1);
    const broken: EventPublisher = {
      publish: async () => {
        throw new Error("broker unavailable");
      },
    };
    await publisherFor("broken", broken, 5_000, 50).execute();
    const { rows } = await db().query(
      `select attempts, next_attempt_at > now() as delayed, last_error from outbox_messages where id = any($1::uuid[])`,
      [eventIds],
    );
    for (const row of rows) {
      expect(row.attempts).toBeGreaterThanOrEqual(1);
      expect(row.delayed).toBe(true);
      expect(row.last_error).toContain("broker unavailable");
    }
    await db().query(`update outbox_messages set next_attempt_at = now() where id = any($1::uuid[])`, [eventIds]);
    await publishUntilEmpty(publisherFor("healthy", sqsPublisher), eventIds);
    expect(await unpublished(eventIds)).toBe(0);
  });

  test("a duplicate publication is absorbed: same eventId, deduplicated by the FIFO queue", async () => {
    const { eventIds } = await seedEvents(1);
    await drain(sqs, eventsUrl, 100, 2_000);
    const [message] = await store.claim("duplicate-test", 1, 5_000);
    expect(message).toBeDefined();
    if (!message) {
      return;
    }
    await sqsPublisher.publish(message);
    await sqsPublisher.publish(message);
    const received = await drain(sqs, eventsUrl, 2, 4_000);
    const copies = received.filter((item) => JSON.parse(item.Body ?? "{}").eventId === message.id);
    expect(copies).toHaveLength(1);
    expect(eventIds.length).toBeGreaterThan(0);
  });
});
