import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppConfig } from "../../src/config/app-config";
import { createSqsClient, QueueUrlResolver } from "../../src/infrastructure/messaging/sqs-client";
import { prepareInfrastructure } from "../support/application";
import { countRows, expectConsistent } from "../support/database";
import { eventually, testConfig } from "../support/environment";
import { createWallet, submit, wagerPayload, type WalletRef } from "../support/http";
import { type InstanceProcess, spawnInstance } from "../support/processes";
import { queueDepth, sendMessage, wagerMessage } from "../support/sqs";

let config: AppConfig;
let instances: InstanceProcess[] = [];

beforeAll(async () => {
  config = testConfig({
    sqs: { consumerEnabled: true, consumerConcurrency: 4 },
    outbox: { enabled: true },
  });
  await prepareInfrastructure(config);
  instances = await Promise.all(["node-1", "node-2", "node-3"].map((name) => spawnInstance(config, name)));
});

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.kill("SIGTERM")));
});

function instanceAt(index: number): InstanceProcess {
  const instance = instances[index % instances.length];
  if (!instance) {
    throw new Error("no instances running");
  }
  return instance;
}

describe("three instances sharing one database and one queue", () => {
  test("the same BET hitting every instance at once debits exactly once", async () => {
    const wallet = await createWallet(instanceAt(0).baseUrl, "500.00");
    const bet = wagerPayload(wallet, { money: { amount: "40.00", currency: "BRL" } });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) => submit(instanceAt(index).baseUrl, bet)),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200)).toHaveLength(29);
    const audit = await expectConsistent(wallet.id);
    expect(audit.debits).toBe(1);
    expect(audit.balance).toBe("460.00");
  });

  test("HTTP and SQS traffic for the same wallets interleave without overdraw or loss", async () => {
    const client = createSqsClient(config.sqs);
    const queueUrl = await new QueueUrlResolver(client, config.sqs.endpoint).resolve(config.sqs.wagerQueue);
    try {
      const wallets: WalletRef[] = [];
      for (let index = 0; index < 4; index += 1) {
        wallets.push(await createWallet(instanceAt(index).baseUrl, "50.00"));
      }

      const viaQueue = wallets.flatMap((wallet) =>
        Array.from({ length: 20 }, () => wagerMessage(wagerPayload(wallet, { money: { amount: "1.00", currency: "BRL" } }))),
      );
      const queued = Promise.all(viaQueue.map((envelope) => sendMessage(client, queueUrl, envelope, envelope.data.walletId)));
      const viaHttp = Promise.all(
        wallets.flatMap((wallet, walletIndex) =>
          Array.from({ length: 40 }, (_, index) =>
            submit(
              instanceAt(walletIndex + index).baseUrl,
              wagerPayload(wallet, { money: { amount: "1.00", currency: "BRL" } }),
            ),
          ),
        ),
      );
      await Promise.all([queued, viaHttp]);

      await eventually(
        () => queueDepth(client, queueUrl),
        (depth) => depth.visible === 0 && depth.inFlight === 0,
        { timeoutMs: 60_000, intervalMs: 500 },
      );
      await eventually(
        () =>
          countRows(`select 1 from inbox_messages where consumer_name = $1 and message_id = any($2::text[])`, [
            config.sqs.consumerName,
            viaQueue.map((envelope) => envelope.messageId),
          ]),
        (processed) => processed === viaQueue.length,
        { timeoutMs: 30_000, intervalMs: 500 },
      );

      for (const wallet of wallets) {
        const audit = await expectConsistent(wallet.id);
        expect(audit.balance).toBe("0.00");
        expect(audit.debits).toBe(50);
        expect(
          await countRows(
            `select 1 from wager_transactions where wallet_id = $1 and kind = 'BET' and status = 'REJECTED' and failure_code = 'INSUFFICIENT_FUNDS'`,
            [wallet.id],
          ),
        ).toBe(10);
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
      client.destroy();
    }
  });
});
