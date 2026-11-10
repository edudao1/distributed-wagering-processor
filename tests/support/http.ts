import { randomUUID } from "node:crypto";

export type Json = Record<string, any>;

export interface HttpResult {
  status: number;
  body: Json;
}

export interface WalletRef {
  id: string;
  playerId: string;
}

export async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
}

export async function createWallet(baseUrl: string, amount = "100.00", currency = "BRL"): Promise<WalletRef> {
  const playerId = randomUUID();
  const result = await request(baseUrl, "POST", "/wallets", { playerId, initialBalance: { amount, currency } });
  if (result.status !== 201) {
    throw new Error(`wallet creation failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return { id: result.body.id, playerId };
}

export function wagerPayload(wallet: WalletRef, overrides: Json = {}): Json {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

export function keyOf(payload: Json): string {
  return `${payload.providerId}:${payload.externalTransactionId}`;
}

export function submit(baseUrl: string, payload: Json, idempotencyKey: string = keyOf(payload)): Promise<HttpResult> {
  return request(baseUrl, "POST", "/wagering/transactions", payload, { "idempotency-key": idempotencyKey });
}
