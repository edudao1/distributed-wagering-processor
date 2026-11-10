import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import { TransientInfrastructureError } from "../../src/application/errors";
import type { WagerTransactionHandler } from "../../src/application/wagering/process-wager-transaction";
import { QueueUrlResolver, SQS_CLIENT } from "../../src/infrastructure/messaging/sqs-client";
import { Sha256PayloadHasher } from "../../src/infrastructure/hashing/sha256-payload-hasher";
import { type ConsumerDecision, WagerTransactionConsumer } from "../../src/interfaces/messaging/wager-transaction.consumer";
import { type TestApplication, startApplication } from "../support/application";
import { countRows, expectConsistent } from "../support/database";
import { eventually, testConfig } from "../support/environment";
import { RecordingMetrics, SilentLogger } from "../support/fakes";
import { createWallet, wagerPayload } from "../support/http";
import { drain, receive, sendMessage, wagerMessage } from "../support/sqs";

let application: TestApplication;
let sqs: SQSClient;
let consumer: WagerTransactionConsumer;
let queueUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  application = await startApplication(testConfig());
  sqs = application.app.get<SQSClient>(SQS_CLIENT);
  consumer = application.app.get(WagerTransactionConsumer);
  const resolver = application.app.get(QueueUrlResolver);
  queueUrl = await resolver.resolve(application.config.sqs.wagerQueue);
  dlqUrl = await resolver.resolve(application.config.sqs.wagerDlq);
});

afterAll(async () => {
  await application.close();
});

async function receiveOne(): Promise<Message> {
  const [message] = await eventually(
    () => receive(sqs, queueUrl),
    (messages) => messages.length > 0,
    { timeoutMs: 15_000, intervalMs: 0 },
  );
  if (!message) {
    throw new Error("no message received");
  }
  return message;
}

describe("inbox", () => {
  test("redelivery of the same message is acknowledged without a second debit", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const envelope = wagerMessage(wagerPayload(wallet));

    await sendMessage(sqs, queueUrl, envelope, wallet.id);
    expect(await consumer.handle(await receiveOne())).toEqual({ action: "ack", reason: "processed" });

    await sendMessage(sqs, queueUrl, envelope, wallet.id);
    expect(await consumer.handle(await receiveOne())).toEqual({ action: "ack", reason: "duplicate" });

    const audit = await expectConsistent(wallet.id);
    expect(audit.debits).toBe(1);
    expect(audit.balance).toBe("75.00");
    expect(await countRows(`select 1 from inbox_messages where message_id = $1`, [envelope.messageId])).toBe(1);
  });

  test("a different business message under a new messageId replays through the idempotency key", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const payload = wagerPayload(wallet);
    await sendMessage(sqs, queueUrl, wagerMessage(payload), wallet.id);
    await consumer.handle(await receiveOne());
    await sendMessage(sqs, queueUrl, wagerMessage(payload), wallet.id);
    expect(await consumer.handle(await receiveOne())).toEqual({ action: "ack", reason: "processed" });
    expect((await expectConsistent(wallet.id)).debits).toBe(1);
  });

  test("the same messageId with another payload goes to the DLQ", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const envelope = wagerMessage(wagerPayload(wallet));
    await sendMessage(sqs, queueUrl, envelope, wallet.id);
    await consumer.handle(await receiveOne());
    const tampered = { ...envelope, data: { ...envelope.data, money: { amount: "99.00", currency: "BRL" } } };
    await sendMessage(sqs, queueUrl, tampered, wallet.id);
    expect(await consumer.handle(await receiveOne())).toEqual({
      action: "dead-letter",
      reason: "INBOX_PAYLOAD_CONFLICT",
    });
    const [deadLetter] = await drain(sqs, dlqUrl, 1);
    expect(deadLetter?.MessageAttributes?.failureReason?.StringValue).toBe("INBOX_PAYLOAD_CONFLICT");
  });
});

describe("error classification", () => {
  test("business rejections are acknowledged, not retried", async () => {
    const wallet = await createWallet(application.baseUrl, "10.00");
    await sendMessage(sqs, queueUrl, wagerMessage(wagerPayload(wallet, { money: { amount: "50.00", currency: "BRL" } })), wallet.id);
    expect(await consumer.handle(await receiveOne())).toEqual({ action: "ack", reason: "processed" });
    expect(
      await countRows(`select 1 from wager_transactions where wallet_id = $1 and failure_code = 'INSUFFICIENT_FUNDS'`, [
        wallet.id,
      ]),
    ).toBe(1);
  });

  test("malformed messages and unknown wallets are permanent failures", async () => {
    await sendMessage(sqs, queueUrl, "{not json", "malformed");
    expect(await consumer.handle(await receiveOne())).toEqual({ action: "dead-letter", reason: "INVALID_MESSAGE" });
    const ghost = { id: randomUUID(), playerId: randomUUID() };
    await sendMessage(sqs, queueUrl, wagerMessage(wagerPayload(ghost)), ghost.id);
    expect(await consumer.handle(await receiveOne())).toEqual({ action: "dead-letter", reason: "WALLET_NOT_FOUND" });
    expect(await drain(sqs, dlqUrl, 2)).toHaveLength(2);
  });

  test("transient failures back off and reach the DLQ after the retry budget", async () => {
    const failing: WagerTransactionHandler = {
      execute: async () => {
        throw new TransientInfrastructureError("database_unavailable");
      },
    };
    const metrics = new RecordingMetrics();
    const flaky = new WagerTransactionConsumer(
      application.config,
      sqs,
      application.app.get(QueueUrlResolver),
      failing,
      new Sha256PayloadHasher(),
      metrics,
      new SilentLogger(),
    );
    const wallet = await createWallet(application.baseUrl, "100.00");
    await sendMessage(sqs, queueUrl, wagerMessage(wagerPayload(wallet)), wallet.id);

    const decisions: ConsumerDecision["action"][] = [];
    while (!decisions.includes("dead-letter")) {
      const message = await receiveOne();
      decisions.push((await flaky.handle(message)).action);
    }
    expect(decisions).toEqual(["retry", "retry", "dead-letter"]);
    expect(metrics.count("retryScheduled")).toBe(2);
    expect(metrics.count("messageDeadLettered")).toBe(1);
    const [deadLetter] = await drain(sqs, dlqUrl, 1);
    expect(deadLetter?.MessageAttributes?.failureReason?.StringValue).toBe("MAX_RECEIVES_EXCEEDED");
    expect((await expectConsistent(wallet.id)).debits).toBe(0);
  });
});
