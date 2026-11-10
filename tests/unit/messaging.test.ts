import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { InvalidMessageStateError } from "../../src/domain/errors";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { WalletBalanceChanged } from "../../src/domain/wagering/events";
import { AT, brl, openWallet } from "../support/builders";

function balanceChangedEvent() {
  const wallet = openWallet("100.00");
  const entry = wallet.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl("10.00"), at: AT });
  return WalletBalanceChanged.from(wallet, entry, { eventId: randomUUID(), correlationId: "corr-1", occurredAt: AT });
}

describe("integration events", () => {
  test("serialize money as decimal strings inside a versioned envelope", () => {
    const event = balanceChangedEvent();
    const json = event.toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(AT.toISOString());
    expect(json.data.money).toEqual({ amount: "10.00", currency: "BRL" });
    expect(json.data.balanceBefore).toEqual({ amount: "100.00", currency: "BRL" });
    expect(json.data.balanceAfter).toEqual({ amount: "90.00", currency: "BRL" });
    expect(json.data.walletVersion).toBe(2);
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe("OutboxMessage", () => {
  test("enqueues an event as pending and due immediately", () => {
    const event = balanceChangedEvent();
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe(event.eventId);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(AT)).toBe(true);
    expect(message.payload.eventType).toBe("WalletBalanceChanged");
  });

  test("schedules retries with exponential backoff", () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.scheduleRetry(AT);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.getTime()).toBe(AT.getTime() + 1_000);
    message.scheduleRetry(AT);
    expect(message.nextAttemptAt?.getTime()).toBe(AT.getTime() + 2_000);
    expect(message.isDue(AT)).toBe(false);
  });

  test("cannot be published twice", () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());
    message.markPublished(AT);
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(AT)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(AT)).toThrow(InvalidMessageStateError);
  });
});

describe("InboxMessage", () => {
  test("tracks processing and payload identity", () => {
    const message = InboxMessage.receive({ messageId: "m-1", consumerName: "c", payloadHash: "h", receivedAt: AT });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(AT);
    expect(message.isProcessed()).toBe(true);
    expect(message.matchesPayload("h")).toBe(true);
    expect(message.matchesPayload("x")).toBe(false);
    expect(() => message.markProcessed(AT)).toThrow(InvalidMessageStateError);
  });
});
