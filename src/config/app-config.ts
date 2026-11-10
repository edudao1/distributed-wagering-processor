import { hostname } from "node:os";
import { z } from "zod";

const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const environmentSchema = z.object({
  PORT: z.coerce.number().int().nonnegative().default(3000),
  INSTANCE_ID: z.string().min(1).default(hostname()),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  SHUTDOWN_TIMEOUT_MS: positive(20_000),
  DATABASE_URL: z.string().min(1).default("postgres://wagering:wagering@localhost:5432/wagering"),
  DB_POOL_MAX: positive(20),
  DB_LOCK_TIMEOUT_MS: positive(5_000),
  DB_STATEMENT_TIMEOUT_MS: positive(15_000),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().min(1).default("test"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default("test"),
  SQS_ENDPOINT: z.string().url().default("http://localhost:4566"),
  SQS_WAGER_QUEUE: z.string().min(1).default("wager-transactions.fifo"),
  SQS_WAGER_DLQ: z.string().min(1).default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE: z.string().min(1).default("wagering-events.fifo"),
  SQS_CONSUMER_ENABLED: flag.default("true"),
  SQS_CONSUMER_NAME: z.string().min(1).default("wagering-processor"),
  SQS_CONSUMER_CONCURRENCY: positive(4),
  SQS_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: positive(30),
  SQS_MAX_RECEIVES: positive(5),
  SQS_RETRY_BASE_DELAY_SECONDS: positive(2),
  SQS_RETRY_MAX_DELAY_SECONDS: positive(300),
  OUTBOX_ENABLED: flag.default("true"),
  OUTBOX_INTERVAL_MS: positive(500),
  OUTBOX_BATCH_SIZE: positive(50),
  OUTBOX_LEASE_MS: positive(30_000),
  PENDING_REFERENCE_ENABLED: flag.default("true"),
  PENDING_REFERENCE_INTERVAL_MS: positive(1_000),
  PENDING_REFERENCE_BATCH_SIZE: positive(50),
  PENDING_REFERENCE_MAX_ATTEMPTS: positive(10),
  PENDING_REFERENCE_BASE_DELAY_MS: positive(1_000),
  PENDING_REFERENCE_MAX_DELAY_MS: positive(60_000),
});

export type LogLevel = z.infer<typeof environmentSchema>["LOG_LEVEL"];

export interface AppConfig {
  instanceId: string;
  port: number;
  logLevel: LogLevel;
  shutdownTimeoutMs: number;
  database: {
    url: string;
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  };
  sqs: {
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    wagerQueue: string;
    wagerDlq: string;
    eventsQueue: string;
    consumerEnabled: boolean;
    consumerName: string;
    consumerConcurrency: number;
    batchSize: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    maxReceives: number;
    retryBaseDelaySeconds: number;
    retryMaxDelaySeconds: number;
  };
  outbox: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    leaseMs: number;
  };
  pendingReference: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

export type ConfigOverrides = {
  [K in keyof AppConfig]?: AppConfig[K] extends object ? Partial<AppConfig[K]> : AppConfig[K];
};

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
  overrides: ConfigOverrides = {},
): AppConfig {
  const present = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined && value !== ""),
  );
  const env = environmentSchema.parse(present);
  const config: AppConfig = {
    instanceId: env.INSTANCE_ID,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    },
    sqs: {
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      wagerQueue: env.SQS_WAGER_QUEUE,
      wagerDlq: env.SQS_WAGER_DLQ,
      eventsQueue: env.SQS_EVENTS_QUEUE,
      consumerEnabled: env.SQS_CONSUMER_ENABLED,
      consumerName: env.SQS_CONSUMER_NAME,
      consumerConcurrency: env.SQS_CONSUMER_CONCURRENCY,
      batchSize: env.SQS_BATCH_SIZE,
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      maxReceives: env.SQS_MAX_RECEIVES,
      retryBaseDelaySeconds: env.SQS_RETRY_BASE_DELAY_SECONDS,
      retryMaxDelaySeconds: env.SQS_RETRY_MAX_DELAY_SECONDS,
    },
    outbox: {
      enabled: env.OUTBOX_ENABLED,
      intervalMs: env.OUTBOX_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      leaseMs: env.OUTBOX_LEASE_MS,
    },
    pendingReference: {
      enabled: env.PENDING_REFERENCE_ENABLED,
      intervalMs: env.PENDING_REFERENCE_INTERVAL_MS,
      batchSize: env.PENDING_REFERENCE_BATCH_SIZE,
      maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
      baseDelayMs: env.PENDING_REFERENCE_BASE_DELAY_MS,
      maxDelayMs: env.PENDING_REFERENCE_MAX_DELAY_MS,
    },
  };
  return mergeConfig(config, overrides);
}

export function mergeConfig(config: AppConfig, overrides: ConfigOverrides): AppConfig {
  return deepMerge(config, overrides);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      merged[key] = deepMerge(base[key], value);
    }
  }
  return merged as T;
}
