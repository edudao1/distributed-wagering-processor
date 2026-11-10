import { expect } from "bun:test";
import pg from "pg";

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering",
    max: 5,
  });
  return pool;
}

export interface WalletAudit {
  balance: string;
  version: number;
  ledgerBalance: string;
  lastBalanceAfter: string | null;
  debits: number;
  credits: number;
}

export async function auditWallet(walletId: string): Promise<WalletAudit> {
  const { rows } = await db().query(
    `select w.balance_amount::text as balance,
            w.version,
            coalesce((select sum(case when direction = 'CREDIT' then amount else -amount end)
                        from wallet_ledger_entries where wallet_id = w.id), 0)::numeric(20,2)::text as ledger_balance,
            (select balance_after::text from wallet_ledger_entries
              where wallet_id = w.id order by seq desc limit 1) as last_balance_after,
            (select count(*) from wallet_ledger_entries where wallet_id = w.id and direction = 'DEBIT')::int as debits,
            (select count(*) from wallet_ledger_entries where wallet_id = w.id and direction = 'CREDIT')::int as credits
       from wallets w
      where w.id = $1`,
    [walletId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }
  return {
    balance: row.balance,
    version: row.version,
    ledgerBalance: row.ledger_balance,
    lastBalanceAfter: row.last_balance_after,
    debits: row.debits,
    credits: row.credits,
  };
}

export async function expectConsistent(walletId: string): Promise<WalletAudit> {
  const audit = await auditWallet(walletId);
  expect(audit.balance).toBe(audit.ledgerBalance);
  expect(audit.lastBalanceAfter ?? "0.00").toBe(audit.balance);
  return audit;
}

export async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db().query(`select count(*)::int as total from (${sql}) as subquery`, params);
  return rows[0]?.total ?? 0;
}
