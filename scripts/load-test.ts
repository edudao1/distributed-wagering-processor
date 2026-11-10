import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";

const baseUrls = (process.env.LOAD_BASE_URLS ?? "http://localhost:3001,http://localhost:3002,http://localhost:3003")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const wallets = Number(process.env.LOAD_WALLETS ?? 50);
const requests = Number(process.env.LOAD_REQUESTS ?? 5_000);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 50);
const hotWalletShare = Number(process.env.LOAD_HOT_WALLET_SHARE ?? 0.2);
const duplicateShare = Number(process.env.LOAD_DUPLICATE_SHARE ?? 0.05);

interface Sample {
  status: number;
  latencyMs: number;
}

interface WalletRef {
  id: string;
  playerId: string;
}

function pick<T>(items: T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) {
    throw new Error("empty collection");
  }
  return item;
}

async function createWallet(baseUrl: string): Promise<WalletRef> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: "1000000.00", currency: "BRL" } }),
  });
  if (response.status !== 201) {
    throw new Error(`wallet creation failed with ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number((sorted[Math.max(0, index)] ?? 0).toFixed(2));
}

async function scrape(baseUrl: string): Promise<Record<string, number>> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  const totals: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") {
      continue;
    }
    const [name, value] = line.split(" ");
    if (!name || value === undefined) {
      continue;
    }
    const metric = name.split("{")[0] ?? name;
    if (metric.startsWith("wagering_lock_conflicts_total") || metric.startsWith("wagering_outbox_lag_seconds") || metric.startsWith("wagering_duplicates_detected_total")) {
      totals[metric] = (totals[metric] ?? 0) + Number(value);
    }
  }
  return totals;
}

const createdWallets: WalletRef[] = [];
for (let index = 0; index < wallets; index += 1) {
  createdWallets.push(await createWallet(pick(baseUrls, index)));
}
const hotWallet = pick(createdWallets, 0);

const samples: Sample[] = [];
let issued = 0;
let previousKey: { key: string; body: string } | undefined;

async function worker(): Promise<void> {
  while (issued < requests) {
    const sequence = issued;
    issued += 1;
    const replay = previousKey !== undefined && Math.random() < duplicateShare;
    let key: string;
    let body: string;
    if (replay && previousKey) {
      key = previousKey.key;
      body = previousKey.body;
    } else {
      const wallet = Math.random() < hotWalletShare ? hotWallet : pick(createdWallets, sequence);
      const externalTransactionId = `load-${randomUUID()}`;
      key = `load-provider:${externalTransactionId}`;
      body = JSON.stringify({
        providerId: "load-provider",
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${sequence}`,
        gameId: "load-game",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      });
      previousKey = { key, body };
    }
    const startedAt = performance.now();
    let status = 0;
    try {
      const response = await fetch(`${pick(baseUrls, sequence)}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body,
      });
      status = response.status;
      await response.arrayBuffer();
    } catch {
      status = 0;
    }
    samples.push({ status, latencyMs: performance.now() - startedAt });
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsedSeconds = (performance.now() - startedAt) / 1000;

const latencies = samples.map((sample) => sample.latencyMs).sort((left, right) => left - right);
const statusCounts: Record<string, number> = {};
for (const sample of samples) {
  statusCounts[String(sample.status)] = (statusCounts[String(sample.status)] ?? 0) + 1;
}
const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;

const metrics: Record<string, number> = {};
for (const baseUrl of baseUrls) {
  for (const [name, value] of Object.entries(await scrape(baseUrl))) {
    metrics[name] = name.includes("lag") ? Math.max(metrics[name] ?? 0, value) : (metrics[name] ?? 0) + value;
  }
}

const report = {
  environment: {
    instances: baseUrls.length,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    memoryGb: Number((totalmem() / 1024 ** 3).toFixed(1)),
    bun: Bun.version,
  },
  methodology: { wallets, requests, concurrency, hotWalletShare, duplicateShare },
  results: {
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    throughputRps: Number((samples.length / elapsedSeconds).toFixed(1)),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99) },
    errorRate: Number((errors / samples.length).toFixed(4)),
    statusCounts,
    lockConflicts: metrics.wagering_lock_conflicts_total ?? 0,
    duplicatesDetected: metrics.wagering_duplicates_detected_total ?? 0,
    outboxLagSecondsAtEnd: metrics.wagering_outbox_lag_seconds ?? 0,
  },
};

writeFileSync("load-test-results.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
