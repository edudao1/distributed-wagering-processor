import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initOrm } from "../../src/infrastructure/persistence/orm";
import { type TestApplication, startApplication } from "../support/application";
import { db, expectConsistent } from "../support/database";
import { ensureSchema, testConfig } from "../support/environment";
import { createWallet } from "../support/http";

let application: TestApplication;

async function sqlError(sql: string, params: unknown[] = []): Promise<string | undefined> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query(sql, params);
    await client.query("commit");
    return undefined;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    return (error as { code?: string }).code;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await ensureSchema();
  const orm = await initOrm(testConfig());
  try {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();
  } finally {
    await orm.close(true);
  }
  application = await startApplication(testConfig());
});

afterAll(async () => {
  await application.close();
});

describe("migrations", () => {
  test("are reversible and leave the expected tables in place", async () => {
    const { rows } = await db().query(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages')`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([
      "inbox_messages",
      "outbox_messages",
      "wager_transactions",
      "wallet_ledger_entries",
      "wallets",
    ]);
  });

  test("create the partial unique index that blocks double reversals", async () => {
    const { rows } = await db().query(
      `select indexdef from pg_indexes where indexname = 'uq_wager_transactions_single_reversal'`,
    );
    expect(rows[0]?.indexdef).toContain("UNIQUE");
    expect(rows[0]?.indexdef).toContain("PROCESSED");
  });
});

describe("database constraints", () => {
  test("reject a negative wallet balance", async () => {
    const code = await sqlError(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values ($1, $2, 'BRL', -1, 1, now(), now())`,
      [randomUUID(), randomUUID()],
    );
    expect(code).toBe("23514");
  });

  test("allow a single wallet per player and currency", async () => {
    const wallet = await createWallet(application.baseUrl, "0.00");
    const code = await sqlError(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values ($1, $2, 'BRL', 0, 1, now(), now())`,
      [randomUUID(), wallet.playerId],
    );
    expect(code).toBe("23505");
  });

  test("keep the ledger append-only", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    expect(await sqlError(`update wallet_ledger_entries set amount = 1 where wallet_id = $1`, [wallet.id])).toBe("55000");
    expect(await sqlError(`delete from wallet_ledger_entries where wallet_id = $1`, [wallet.id])).toBe("55000");
    expect(await sqlError(`truncate wallet_ledger_entries`)).toBe("55000");
    await expectConsistent(wallet.id);
  });

  test("validate the arithmetic of every ledger entry", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const code = await sqlError(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values ($1, $2, $3, 'DEBIT', 10, 'BRL', 100, 95, now())`,
      [randomUUID(), wallet.id, randomUUID()],
    );
    expect(code).toBe("23514");
  });

  test("freeze terminal transactions", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const code = await sqlError(
      `update wager_transactions set status = 'REJECTED', failure_code = 'X' where wallet_id = $1`,
      [wallet.id],
    );
    expect(code).toBe("55000");
  });

  test("refuse a balance change without a matching ledger entry", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const code = await sqlError(
      `update wallets set balance_amount = balance_amount + 1, version = version + 1 where id = $1`,
      [wallet.id],
    );
    expect(code).toBe("23514");
    await expectConsistent(wallet.id);
  });

  test("refuse a balance change that does not bump the version", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const code = await sqlError(`update wallets set balance_amount = balance_amount + 1 where id = $1`, [wallet.id]);
    expect(code).toBe("23514");
  });
});
