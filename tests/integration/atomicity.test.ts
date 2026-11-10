import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConcurrentWriteConflictError } from "../../src/application/errors";
import type { TransactionScope, UnitOfWork } from "../../src/application/ports/persistence";
import { UNIT_OF_WORK } from "../../src/application/ports/tokens";
import { SettlementRecorder } from "../../src/application/wagering/settlement-recorder";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { Money } from "../../src/domain/money/money";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerSettlement } from "../../src/domain/wagering/wager-settlement";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import { retryPolicy } from "../support/builders";
import { type TestApplication, startApplication } from "../support/application";
import { countRows, expectConsistent } from "../support/database";
import { testConfig } from "../support/environment";
import { ids, RecordingMetrics } from "../support/fakes";
import { createWallet, type WalletRef } from "../support/http";

let application: TestApplication;
let uow: UnitOfWork;

beforeAll(async () => {
  application = await startApplication(testConfig());
  uow = application.app.get<UnitOfWork>(UNIT_OF_WORK);
});

afterAll(async () => {
  await application.close();
});

function bet(wallet: WalletRef, externalTransactionId: string, idempotencyKey = `provider-a:${externalTransactionId}`) {
  return WagerTransaction.create({
    id: ids.next(),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey,
    payloadHash: "f".repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: "10.00", currency: "BRL" }),
    createdAt: new Date(),
  });
}

async function settleBet(scope: TransactionScope, wallet: WalletRef, externalTransactionId: string): Promise<void> {
  const loaded = await scope.wallets.findByIdForUpdate(wallet.id);
  if (!loaded) {
    throw new Error("wallet not found");
  }
  const transaction = bet(wallet, externalTransactionId);
  const outcome = new WagerSettlement().settle({
    transaction,
    wallet: loaded,
    reference: { type: "none" },
    retryPolicy,
    ledgerEntryId: ids.next(),
    at: new Date(),
  });
  new SettlementRecorder(ids, new RecordingMetrics()).record(scope, {
    transaction,
    wallet: loaded,
    outcome,
    correlationId: "atomicity",
    at: new Date(),
  });
}

async function footprint(wallet: WalletRef, externalTransactionId: string, messageId: string) {
  return {
    transactions: await countRows(`select 1 from wager_transactions where external_transaction_id = $1`, [
      externalTransactionId,
    ]),
    ledger: await countRows(`select 1 from wallet_ledger_entries where wallet_id = $1`, [wallet.id]),
    outbox: await countRows(`select 1 from outbox_messages where aggregate_id = $1`, [wallet.id]),
    inbox: await countRows(`select 1 from inbox_messages where message_id = $1`, [messageId]),
  };
}

describe("atomicity", () => {
  test("a crash before commit leaves no wallet, ledger, inbox or outbox change behind", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const externalTransactionId = `atomic-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const before = await footprint(wallet, externalTransactionId, messageId);

    const work = uow.run(async (scope) => {
      const inbox = InboxMessage.receive({
        messageId,
        consumerName: "atomicity",
        payloadHash: "e".repeat(64),
        receivedAt: new Date(),
      });
      inbox.markProcessed(new Date());
      await scope.inbox.record(inbox);
      await settleBet(scope, wallet, externalTransactionId);
      throw new Error("process died before commit");
    });

    await expect(work).rejects.toThrow("process died before commit");
    expect(await footprint(wallet, externalTransactionId, messageId)).toEqual(before);
    const audit = await expectConsistent(wallet.id);
    expect(audit.balance).toBe("100.00");
  });

  test("a constraint violation during flush rolls back every write of the unit of work", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const externalTransactionId = `atomic-${randomUUID()}`;
    const before = await footprint(wallet, externalTransactionId, "none");

    const work = uow.run(async (scope) => {
      await settleBet(scope, wallet, externalTransactionId);
      const clash = bet(wallet, `other-${randomUUID()}`, `provider-a:${externalTransactionId}`);
      clash.reject(FailureCode.InsufficientFunds, new Date());
      scope.transactions.save(clash);
    });

    await expect(work).rejects.toBeInstanceOf(ConcurrentWriteConflictError);
    expect(await footprint(wallet, externalTransactionId, "none")).toEqual(before);
    expect((await expectConsistent(wallet.id)).balance).toBe("100.00");
  });

  test("a successful unit of work persists wallet, ledger and outbox together", async () => {
    const wallet = await createWallet(application.baseUrl, "100.00");
    const externalTransactionId = `atomic-${randomUUID()}`;
    await uow.run((scope) => settleBet(scope, wallet, externalTransactionId));
    const after = await footprint(wallet, externalTransactionId, "none");
    expect(after.transactions).toBe(1);
    expect(after.ledger).toBe(2);
    expect(after.outbox).toBe(4);
    expect((await expectConsistent(wallet.id)).balance).toBe("90.00");
  });
});
