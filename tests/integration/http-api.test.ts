import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestApplication, startApplication } from "../support/application";
import { db, expectConsistent } from "../support/database";
import { testConfig } from "../support/environment";
import { createWallet, request, submit, wagerPayload } from "../support/http";

let application: TestApplication;
let baseUrl: string;

beforeAll(async () => {
  application = await startApplication(testConfig());
  baseUrl = application.baseUrl;
});

afterAll(async () => {
  await application.close();
});

describe("wallets", () => {
  test("are created with an OPENING credit and version 1", async () => {
    const playerId = randomUUID();
    const created = await request(baseUrl, "POST", "/wallets", {
      playerId,
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    const audit = await expectConsistent(created.body.id);
    expect(audit.credits).toBe(1);

    const fetched = await request(baseUrl, "GET", `/wallets/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
  });

  test("duplicates for the same player and currency are conflicts", async () => {
    const wallet = await createWallet(baseUrl, "10.00");
    const duplicate = await request(baseUrl, "POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "BRL" },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("WALLET_ALREADY_EXISTS");
    const otherCurrency = await request(baseUrl, "POST", "/wallets", {
      playerId: wallet.playerId,
      initialBalance: { amount: "5.00", currency: "USD" },
    });
    expect(otherCurrency.status).toBe(201);
  });

  test("invalid input and unknown ids are distinguished", async () => {
    const invalid = await request(baseUrl, "POST", "/wallets", {
      playerId: randomUUID(),
      initialBalance: { amount: "10.001", currency: "BRL" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_PAYLOAD");
    expect((await request(baseUrl, "GET", `/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await request(baseUrl, "GET", "/wallets/not-a-uuid")).status).toBe(400);
  });
});

describe("wager transactions", () => {
  test("map every situation to a distinct HTTP status", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const bet = wagerPayload(wallet);

    const missingKey = await request(baseUrl, "POST", "/wagering/transactions", bet);
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const invalid = await submit(baseUrl, { ...bet, money: { amount: "1e3", currency: "BRL" } });
    expect(invalid.status).toBe(400);
    expect((await submit(baseUrl, wagerPayload(wallet, { kind: "OPENING" }))).status).toBe(400);

    const created = await submit(baseUrl, bet);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" },
      idempotentReplay: false,
    });

    const replay = await submit(baseUrl, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...created.body, idempotentReplay: true });

    const conflict = await submit(baseUrl, { ...bet, money: { amount: "30.00", currency: "BRL" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", details: { reason: "PAYLOAD_MISMATCH" } });

    const rejected = await submit(baseUrl, wagerPayload(wallet, { money: { amount: "500.00", currency: "BRL" } }));
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });

    const pending = await submit(
      baseUrl,
      wagerPayload(wallet, { kind: "REFUND", referenceExternalTransactionId: `missing-${randomUUID()}` }),
    );
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe("PENDING_REFERENCE");

    const unknownWallet = await submit(baseUrl, wagerPayload({ id: randomUUID(), playerId: wallet.playerId }));
    expect(unknownWallet.status).toBe(404);

    await expectConsistent(wallet.id);
  });

  test("can be looked up by internal id and by provider id", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const bet = wagerPayload(wallet);
    const created = await submit(baseUrl, bet);
    const byId = await request(baseUrl, "GET", `/wagering/transactions/${created.body.transactionId}`);
    const byExternal = await request(
      baseUrl,
      "GET",
      `/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: "BET", status: "PROCESSED", money: { amount: "25.00", currency: "BRL" } });
    expect(byExternal.body).toEqual(byId.body);
    expect((await request(baseUrl, "GET", `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
  });

  test("a REFUND reverses a BET exactly once and a ROLLBACK cannot overdraw the wallet", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const bet = wagerPayload(wallet, { money: { amount: "40.00", currency: "BRL" } });
    await submit(baseUrl, bet);
    const refund = (externalTransactionId: string) =>
      wagerPayload(wallet, {
        kind: "REFUND",
        externalTransactionId,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: { amount: "40.00", currency: "BRL" },
      });
    expect((await submit(baseUrl, refund(`refund-${randomUUID()}`))).status).toBe(201);
    const second = await submit(baseUrl, refund(`refund-${randomUUID()}`));
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe("ALREADY_REVERSED");

    const win = wagerPayload(wallet, { kind: "WIN", money: { amount: "500.00", currency: "BRL" } });
    await submit(baseUrl, win);
    await submit(baseUrl, wagerPayload(wallet, { money: { amount: "550.00", currency: "BRL" } }));
    const rollback = await submit(
      baseUrl,
      wagerPayload(wallet, {
        kind: "ROLLBACK",
        referenceExternalTransactionId: win.externalTransactionId,
        money: { amount: "500.00", currency: "BRL" },
      }),
    );
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    expect((await expectConsistent(wallet.id)).balance).toBe("50.00");
  });
});

describe("ledger", () => {
  test("pages with a stable opaque cursor", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    for (let index = 0; index < 5; index += 1) {
      await submit(baseUrl, wagerPayload(wallet, { money: { amount: "1.00", currency: "BRL" } }));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = await request(baseUrl, "GET", `/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((item: { id: string }) => item.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect((await request(baseUrl, "GET", `/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
  });
});

describe("reconciliation", () => {
  test("confirms consistent wallets", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    await submit(baseUrl, wagerPayload(wallet));
    const result = await request(baseUrl, "POST", `/wallets/${wallet.id}/reconciliation`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "75.00", currency: "BRL" },
      calculatedBalance: { amount: "75.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("flags divergences without correcting them", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const client = await db().connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query("update wallets set balance_amount = 90 where id = $1", [wallet.id]);
      await client.query("set session_replication_role = origin");
    } finally {
      client.release();
    }
    const result = await request(baseUrl, "POST", `/wallets/${wallet.id}/reconciliation`);
    expect(result.body).toMatchObject({ consistent: false, difference: { amount: "-10.00", currency: "BRL" } });
    const stored = await request(baseUrl, "GET", `/wallets/${wallet.id}`);
    expect(stored.body.balance.amount).toBe("90.00");
    const metrics = await fetch(`${baseUrl}/metrics`).then((response) => response.text());
    expect(metrics).toContain('wagering_reconciliations_total{result="divergent"} 1');
  });
});

describe("operations", () => {
  test("health checks and metrics are public", async () => {
    expect((await request(baseUrl, "GET", "/health/live")).status).toBe(200);
    const ready = await request(baseUrl, "GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database.status).toBe("up");
    expect(ready.body.checks.sqs.status).toBe("up");
    const metrics = await fetch(`${baseUrl}/metrics`).then((response) => response.text());
    expect(metrics).toContain("wagering_transactions_total");
  });
});
