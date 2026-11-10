import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChangeMessageVisibilityCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { createSqsClient, QueueUrlResolver, SQS_CLIENT } from "../../src/infrastructure/messaging/sqs-client";
import { WagerTransactionConsumer } from "../../src/interfaces/messaging/wager-transaction.consumer";
import { prepareInfrastructure, type TestApplication, startApplication } from "../support/application";
import { countRows, expectConsistent } from "../support/database";
import { eventually, testConfig } from "../support/environment";
import { createWallet, request, submit, wagerPayload, type WalletRef } from "../support/http";
import { spawnInstance } from "../support/processes";
import { queueDepth, receive, sendMessage, wagerMessage } from "../support/sqs";

describe("worker killed after commit and before ack", () => {
  let application: TestApplication;

  beforeAll(async () => {
    application = await startApplication(testConfig());
  });

  afterAll(async () => {
    await application.close();
  });

  test("the redelivered message is deduplicated by the inbox", async () => {
    const client = application.app.get<SQSClient>(SQS_CLIENT);
    const consumer = application.app.get(WagerTransactionConsumer);
    const queueUrl = await application.app.get(QueueUrlResolver).resolve(application.config.sqs.wagerQueue);
    const wallet = await createWallet(application.baseUrl, "100.00");
    const envelope = wagerMessage(wagerPayload(wallet));
    await sendMessage(client, queueUrl, envelope, wallet.id);

    const [message] = await eventually(
      () => receive(client, queueUrl),
      (messages) => messages.length > 0,
      { timeoutMs: 15_000, intervalMs: 0 },
    );
    if (!message) {
      throw new Error("message not received");
    }
    expect(await consumer.decide(message)).toEqual({ action: "ack", reason: "processed" });
    await client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
    );

    consumer.start();
    try {
      await eventually(
        () => queueDepth(client, queueUrl),
        (depth) => depth.visible === 0 && depth.inFlight === 0,
        { timeoutMs: 20_000 },
      );
    } finally {
      await consumer.stop();
    }

    const audit = await expectConsistent(wallet.id);
    expect(audit.debits).toBe(1);
    expect(audit.balance).toBe("75.00");
    expect(await countRows(`select 1 from inbox_messages where message_id = $1`, [envelope.messageId])).toBe(1);
  });
});

describe("process restart", () => {
  test("a SIGKILL in the middle of a stream loses nothing and duplicates nothing", async () => {
    const config = testConfig({
      sqs: { consumerEnabled: true, consumerConcurrency: 4, visibilityTimeoutSeconds: 3 },
      outbox: { enabled: true },
      pendingReference: { enabled: true, baseDelayMs: 200, maxDelayMs: 500, maxAttempts: 500 },
    });
    await prepareInfrastructure(config);
    const client = createSqsClient(config.sqs);
    const queueUrl = await new QueueUrlResolver(client, config.sqs.endpoint).resolve(config.sqs.wagerQueue);

    const first = await spawnInstance(config, "victim");
    const wallets: WalletRef[] = [];
    for (let index = 0; index < 5; index += 1) {
      wallets.push(await createWallet(first.baseUrl, "1000.00"));
    }
    const [hotWallet] = wallets as [WalletRef, ...WalletRef[]];
    const lateBetId = `late-bet-${randomUUID()}`;
    const parked = await submit(
      first.baseUrl,
      wagerPayload(hotWallet, {
        kind: "REFUND",
        referenceExternalTransactionId: lateBetId,
        money: { amount: "7.00", currency: "BRL" },
      }),
    );
    expect(parked.body.status).toBe("PENDING_REFERENCE");

    const perWallet = 30;
    for (const wallet of wallets) {
      for (let index = 0; index < perWallet; index += 1) {
        await sendMessage(
          client,
          queueUrl,
          wagerMessage(wagerPayload(wallet, { money: { amount: "1.00", currency: "BRL" } })),
          wallet.id,
        );
      }
    }

    await eventually(
      () => countRows(`select 1 from inbox_messages where consumer_name = $1`, [config.sqs.consumerName]),
      (count) => count > 0,
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    await first.kill("SIGKILL");

    const second = await spawnInstance(config, "successor");
    try {
      const lateBet = await submit(
        second.baseUrl,
        wagerPayload(hotWallet, { externalTransactionId: lateBetId, money: { amount: "7.00", currency: "BRL" } }),
      );
      expect(lateBet.body.status).toBe("PROCESSED");
      await eventually(
        () => queueDepth(client, queueUrl),
        (depth) => depth.visible === 0 && depth.inFlight === 0,
        { timeoutMs: 60_000, intervalMs: 500 },
      );
      await eventually(
        async () => (await request(second.baseUrl, "GET", `/wagering/transactions/${parked.body.transactionId}`)).body.status,
        (status) => status === "PROCESSED",
        { timeoutMs: 20_000 },
      );
      for (const wallet of wallets) {
        const audit = await expectConsistent(wallet.id);
        expect(audit.balance).toBe("970.00");
        expect(audit.debits).toBe(wallet === hotWallet ? perWallet + 1 : perWallet);
      }
      await eventually(
        () =>
          countRows(`select 1 from outbox_messages where aggregate_id = any($1::text[]) and published_at is null`, [
            wallets.map((wallet) => wallet.id),
          ]),
        (pending) => pending === 0,
        { timeoutMs: 30_000, intervalMs: 500 },
      );
    } finally {
      await second.kill("SIGTERM");
      client.destroy();
    }
  });
});
