import { randomUUID } from "node:crypto";
import { type AppConfig, type ConfigOverrides, type LogLevel, loadConfig, mergeConfig } from "../../src/config/app-config";
import { initOrm } from "../../src/infrastructure/persistence/orm";

export function uniqueQueues(): Pick<AppConfig["sqs"], "wagerQueue" | "wagerDlq" | "eventsQueue"> {
  const id = randomUUID().slice(0, 8);
  return { wagerQueue: `wt-${id}.fifo`, wagerDlq: `wt-dlq-${id}.fifo`, eventsQueue: `ev-${id}.fifo` };
}

export function testConfig(overrides: ConfigOverrides = {}): AppConfig {
  const base = loadConfig(process.env, {
    instanceId: `test-${randomUUID().slice(0, 8)}`,
    logLevel: (process.env.TEST_LOG_LEVEL ?? "silent") as LogLevel,
    shutdownTimeoutMs: 5_000,
    database: { poolMax: 10, lockTimeoutMs: 10_000 },
    sqs: {
      ...uniqueQueues(),
      consumerEnabled: false,
      consumerConcurrency: 2,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 5,
      maxReceives: 3,
      retryBaseDelaySeconds: 1,
      retryMaxDelaySeconds: 2,
    },
    outbox: { enabled: false, intervalMs: 100, leaseMs: 5_000 },
    pendingReference: { enabled: false, intervalMs: 100, baseDelayMs: 50, maxDelayMs: 200, maxAttempts: 10 },
  });
  return mergeConfig(base, overrides);
}

let migrated: Promise<void> | undefined;

export function ensureSchema(): Promise<void> {
  migrated ??= (async () => {
    const orm = await initOrm(testConfig());
    try {
      await orm.getMigrator().up();
    } finally {
      await orm.close(true);
    }
  })();
  return migrated;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function eventually<T>(
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 200 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!accept(last)) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
    }
    await sleep(intervalMs);
    last = await probe();
  }
  return last;
}
