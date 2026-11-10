import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RetryPendingReferences } from "../../src/application/wagering/retry-pending-references";
import { type TestApplication, startApplication } from "../support/application";
import { countRows, expectConsistent } from "../support/database";
import { eventually, testConfig } from "../support/environment";
import { createWallet, request, submit, wagerPayload } from "../support/http";

let application: TestApplication;
let baseUrl: string;
let retry: RetryPendingReferences;

beforeAll(async () => {
  application = await startApplication(
    testConfig({ pendingReference: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 100 } }),
  );
  baseUrl = application.baseUrl;
  retry = application.app.get(RetryPendingReferences);
});

afterAll(async () => {
  await application.close();
});

async function statusOf(transactionId: string): Promise<string> {
  return (await request(baseUrl, "GET", `/wagering/transactions/${transactionId}`)).body.status;
}

describe("references delivered out of order", () => {
  test("a REFUND that arrives before its BET waits and is applied once the BET lands", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const bet = wagerPayload(wallet, { money: { amount: "40.00", currency: "BRL" } });
    const refund = wagerPayload(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: "40.00", currency: "BRL" },
    });

    const early = await submit(baseUrl, refund);
    expect(early.status).toBe(202);
    expect(early.body.status).toBe("PENDING_REFERENCE");

    expect((await submit(baseUrl, bet)).status).toBe(201);
    await eventually(
      async () => {
        await retry.execute(50);
        return statusOf(early.body.transactionId);
      },
      (status) => status === "PROCESSED",
      { timeoutMs: 10_000, intervalMs: 60 },
    );

    const replay = await submit(baseUrl, refund);
    expect(replay.body).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
    const audit = await expectConsistent(wallet.id);
    expect(audit.balance).toBe("100.00");
    expect(audit.debits).toBe(1);
    expect(audit.credits).toBe(2);
  });

  test("a ROLLBACK that arrives before its WIN is applied as a debit later", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const win = wagerPayload(wallet, { kind: "WIN", money: { amount: "15.00", currency: "BRL" } });
    const rollback = wagerPayload(wallet, {
      kind: "ROLLBACK",
      referenceExternalTransactionId: win.externalTransactionId,
      money: { amount: "15.00", currency: "BRL" },
    });
    const early = await submit(baseUrl, rollback);
    expect(early.status).toBe(202);
    await submit(baseUrl, win);
    await eventually(
      async () => {
        await retry.execute(50);
        return statusOf(early.body.transactionId);
      },
      (status) => status === "PROCESSED",
      { timeoutMs: 10_000, intervalMs: 60 },
    );
    expect((await expectConsistent(wallet.id)).balance).toBe("100.00");
  });

  test("a reference that never arrives is rejected as REFERENCE_NOT_FOUND and announced", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const orphan = await submit(
      baseUrl,
      wagerPayload(wallet, { kind: "REFUND", referenceExternalTransactionId: `ghost-${randomUUID()}` }),
    );
    await eventually(
      async () => {
        await retry.execute(50);
        return (await request(baseUrl, "GET", `/wagering/transactions/${orphan.body.transactionId}`)).body;
      },
      (body) => body.status === "REJECTED",
      { timeoutMs: 10_000, intervalMs: 60 },
    );
    const final = await request(baseUrl, "GET", `/wagering/transactions/${orphan.body.transactionId}`);
    expect(final.body).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND", referenceAttempts: 2 });
    expect(
      await countRows(
        `select 1 from outbox_messages where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = $1`,
        [orphan.body.transactionId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        `select 1 from outbox_messages where event_type = 'WagerTransactionPendingReference' and payload->'data'->>'transactionId' = $1`,
        [orphan.body.transactionId],
      ),
    ).toBe(1);
    expect((await expectConsistent(wallet.id)).balance).toBe("100.00");
  });

  test("concurrent retry workers settle a pending reversal exactly once", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const bet = wagerPayload(wallet, { money: { amount: "10.00", currency: "BRL" } });
    const refund = wagerPayload(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId,
      money: { amount: "10.00", currency: "BRL" },
    });
    const early = await submit(baseUrl, refund);
    await submit(baseUrl, bet);
    await eventually(
      async () => {
        await Promise.all([retry.execute(50), retry.execute(50), retry.execute(50)]);
        return statusOf(early.body.transactionId);
      },
      (status) => status === "PROCESSED",
      { timeoutMs: 10_000, intervalMs: 60 },
    );
    const audit = await expectConsistent(wallet.id);
    expect(audit.balance).toBe("100.00");
    expect(audit.credits).toBe(2);
  });
});
