import { EntitySchema } from "@mikro-orm/core";

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid", fieldName: "player_id" },
    currency: { type: "string", columnType: "char(3)" },
    balanceAmount: { type: "string", fieldName: "balance_amount", columnType: "numeric(20,2)" },
    version: { type: "integer" },
    createdAt: { type: "datetime", fieldName: "created_at", columnType: "timestamptz" },
    updatedAt: { type: "datetime", fieldName: "updated_at", columnType: "timestamptz" },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalanceAmount!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id" },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "string", fieldName: "idempotency_key" },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "uuid", fieldName: "player_id" },
    roundId: { type: "string", fieldName: "round_id" },
    gameId: { type: "string", fieldName: "game_id" },
    kind: { type: "string" },
    amount: { type: "string", columnType: "numeric(20,2)" },
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    referenceTransactionId: { type: "uuid", fieldName: "reference_transaction_id", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", fieldName: "failure_code", nullable: true },
    observedBalanceAmount: {
      type: "string",
      fieldName: "observed_balance_amount",
      columnType: "numeric(20,2)",
      nullable: true,
    },
    referenceAttempts: { type: "integer", fieldName: "reference_attempts" },
    nextReferenceAttemptAt: {
      type: "datetime",
      fieldName: "next_reference_attempt_at",
      columnType: "timestamptz",
      nullable: true,
    },
    createdAt: { type: "datetime", fieldName: "created_at", columnType: "timestamptz" },
    processedAt: { type: "datetime", fieldName: "processed_at", columnType: "timestamptz", nullable: true },
    updatedAt: { type: "datetime", fieldName: "updated_at", columnType: "timestamptz" },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string" },
    amount: { type: "string", columnType: "numeric(20,2)" },
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: { type: "string", fieldName: "balance_before", columnType: "numeric(20,2)" },
    balanceAfter: { type: "string", fieldName: "balance_after", columnType: "numeric(20,2)" },
    createdAt: { type: "datetime", fieldName: "created_at", columnType: "timestamptz" },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id" },
    eventType: { type: "string", fieldName: "event_type" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { type: "datetime", fieldName: "occurred_at", columnType: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", fieldName: "next_attempt_at", columnType: "timestamptz" },
    publishedAt: { type: "datetime", fieldName: "published_at", columnType: "timestamptz", nullable: true },
  },
});

export const ENTITY_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxSchema];
