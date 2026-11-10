import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type TestApplication, startApplication } from "../support/application";
import { expectConsistent } from "../support/database";
import { testConfig } from "../support/environment";
import { createWallet, submit, wagerPayload } from "../support/http";

let application: TestApplication;
let baseUrl: string;

beforeAll(async () => {
  application = await startApplication(testConfig({ database: { poolMax: 30 } }));
  baseUrl = application.baseUrl;
});

afterAll(async () => {
  await application.close();
});

describe("same wallet under real parallelism", () => {
  test("the same BET sent 50 times in parallel debits exactly once", async () => {
    const wallet = await createWallet(baseUrl, "1000.00");
    const bet = wagerPayload(wallet);
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(baseUrl, bet)));

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200)).toHaveLength(49);
    expect(new Set(results.map((result) => result.body.transactionId)).size).toBe(1);
    for (const result of results) {
      expect(result.body.balance).toEqual({ amount: "975.00", currency: "BRL" });
    }
    const audit = await expectConsistent(wallet.id);
    expect(audit.debits).toBe(1);
    expect(audit.balance).toBe("975.00");
  });

  test("two BETs of 80.00 racing for 100.00: one PROCESSED, one REJECTED", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const bets = [1, 2].map(() => wagerPayload(wallet, { money: { amount: "80.00", currency: "BRL" } }));
    const results = await Promise.all(bets.map((bet) => submit(baseUrl, bet)));

    const statuses = results.map((result) => result.body.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    expect(results.find((result) => result.body.status === "REJECTED")?.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    const audit = await expectConsistent(wallet.id);
    expect(audit.balance).toBe("20.00");
    expect(audit.debits).toBe(1);

    const retries = await Promise.all(bets.map((bet) => submit(baseUrl, bet)));
    expect(retries.map((result) => result.body.idempotentReplay)).toEqual([true, true]);
    expect(retries.map((result) => result.body.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect((await expectConsistent(wallet.id)).debits).toBe(1);
  });

  test("200 concurrent bets never overdraw a hot wallet", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        submit(baseUrl, wagerPayload(wallet, { money: { amount: "1.00", currency: "BRL" } })),
      ),
    );
    expect(results.filter((result) => result.body.status === "PROCESSED")).toHaveLength(100);
    expect(results.filter((result) => result.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(100);
    const audit = await expectConsistent(wallet.id);
    expect(audit.balance).toBe("0.00");
    expect(audit.debits).toBe(100);
  });

  test("ten concurrent REFUNDs of the same BET credit it once", async () => {
    const wallet = await createWallet(baseUrl, "100.00");
    const bet = wagerPayload(wallet, { money: { amount: "30.00", currency: "BRL" } });
    await submit(baseUrl, bet);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        submit(
          baseUrl,
          wagerPayload(wallet, {
            kind: "REFUND",
            externalTransactionId: `refund-${randomUUID()}`,
            referenceExternalTransactionId: bet.externalTransactionId,
            money: { amount: "30.00", currency: "BRL" },
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.body.status === "PROCESSED")).toHaveLength(1);
    expect(results.filter((result) => result.body.failureCode === "ALREADY_REVERSED")).toHaveLength(9);
    expect((await expectConsistent(wallet.id)).balance).toBe("100.00");
  });
});

describe("different wallets", () => {
  test("are processed in parallel without interfering", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(baseUrl, "100.00")));
    const startedAt = performance.now();
    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 10 }, () =>
          submit(baseUrl, wagerPayload(wallet, { money: { amount: "5.00", currency: "BRL" } })),
        ),
      ),
    );
    const elapsedMs = performance.now() - startedAt;
    for (const wallet of wallets) {
      const audit = await expectConsistent(wallet.id);
      expect(audit.balance).toBe("50.00");
      expect(audit.debits).toBe(10);
    }
    expect(elapsedMs).toBeLessThan(60_000);
  });
});
