import { createServer } from "node:net";
import type { Subprocess } from "bun";
import type { AppConfig } from "../../src/config/app-config";
import { sleep } from "./environment";

export interface InstanceProcess {
  name: string;
  baseUrl: string;
  process: Subprocess;
  kill(signal?: NodeJS.Signals | number): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function environmentFor(config: AppConfig, name: string, port: number): Record<string, string> {
  return {
    PORT: String(port),
    INSTANCE_ID: name,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "warn",
    DATABASE_URL: config.database.url,
    DB_POOL_MAX: String(config.database.poolMax),
    DB_LOCK_TIMEOUT_MS: String(config.database.lockTimeoutMs),
    SQS_ENDPOINT: config.sqs.endpoint,
    SQS_WAGER_QUEUE: config.sqs.wagerQueue,
    SQS_WAGER_DLQ: config.sqs.wagerDlq,
    SQS_EVENTS_QUEUE: config.sqs.eventsQueue,
    SQS_CONSUMER_ENABLED: String(config.sqs.consumerEnabled),
    SQS_CONSUMER_NAME: config.sqs.consumerName,
    SQS_CONSUMER_CONCURRENCY: String(config.sqs.consumerConcurrency),
    SQS_WAIT_TIME_SECONDS: String(config.sqs.waitTimeSeconds),
    SQS_VISIBILITY_TIMEOUT_SECONDS: String(config.sqs.visibilityTimeoutSeconds),
    SQS_MAX_RECEIVES: String(config.sqs.maxReceives),
    SQS_RETRY_BASE_DELAY_SECONDS: String(config.sqs.retryBaseDelaySeconds),
    SQS_RETRY_MAX_DELAY_SECONDS: String(config.sqs.retryMaxDelaySeconds),
    OUTBOX_ENABLED: String(config.outbox.enabled),
    OUTBOX_INTERVAL_MS: String(config.outbox.intervalMs),
    OUTBOX_LEASE_MS: String(config.outbox.leaseMs),
    PENDING_REFERENCE_ENABLED: String(config.pendingReference.enabled),
    PENDING_REFERENCE_INTERVAL_MS: String(config.pendingReference.intervalMs),
    PENDING_REFERENCE_BASE_DELAY_MS: String(config.pendingReference.baseDelayMs),
    PENDING_REFERENCE_MAX_DELAY_MS: String(config.pendingReference.maxDelayMs),
    PENDING_REFERENCE_MAX_ATTEMPTS: String(config.pendingReference.maxAttempts),
  };
}

export async function spawnInstance(config: AppConfig, name: string): Promise<InstanceProcess> {
  const port = await freePort();
  const child = Bun.spawn({
    cmd: [process.execPath, "src/main.ts"],
    cwd: process.cwd(),
    env: { ...process.env, ...environmentFor(config, name, port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (!ready) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited early with code ${child.exitCode}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`${name} did not become live within 30s`);
    }
    ready = await fetch(`${baseUrl}/health/live`).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) {
      await sleep(200);
    }
  }
  return {
    name,
    baseUrl,
    process: child,
    async kill(signal: NodeJS.Signals | number = "SIGKILL") {
      if (child.exitCode === null) {
        child.kill(signal);
      }
      await child.exited;
    },
  };
}
