import { randomUUID } from "node:crypto";
import { Money } from "../../src/domain/money/money";
import { ReferenceRetryPolicy } from "../../src/domain/wagering/reference-retry-policy";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import { Wallet } from "../../src/domain/wallet/wallet";

export const AT = new Date("2026-07-29T15:00:00.000Z");

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

export function openWallet(amount = "100.00", currency = "BRL"): Wallet {
  const initialBalance = Money.from({ amount, currency });
  const wallet = Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance,
    at: AT,
    opening: initialBalance.isPositive() ? { transactionId: randomUUID(), entryId: randomUUID() } : undefined,
  });
  wallet.pullUncommittedEntries();
  return wallet;
}

export interface TransactionOverrides {
  kind?: WagerTransactionKind;
  money?: Money;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
}

export function transactionFor(wallet: Wallet, overrides: TransactionOverrides = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  const providerId = overrides.providerId ?? "provider-a";
  return WagerTransaction.create({
    id: randomUUID(),
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: "a".repeat(64),
    walletId: overrides.walletId ?? wallet.id,
    playerId: overrides.playerId ?? wallet.playerId,
    roundId: overrides.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: overrides.money ?? brl("10.00"),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    createdAt: AT,
  });
}

export const retryPolicy = ReferenceRetryPolicy.create({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 });
