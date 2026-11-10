import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { describeError } from "../../application/errors";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { QueueUrlResolver, SQS_CLIENT } from "../../infrastructure/messaging/sqs-client";
import { PrometheusMetrics } from "../../infrastructure/observability/prometheus-metrics";
import { MIKRO_ORM } from "../../infrastructure/persistence/orm";
import { Public } from "./auth";

interface DependencyCheck {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
}

const CHECK_TIMEOUT_MS = 2_000;

async function check(probe: () => Promise<unknown>): Promise<DependencyCheck> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: "up", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return { status: "down", latencyMs: Math.round(performance.now() - startedAt), error: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

@Public()
@Controller()
export class OperationsController {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QueueUrlResolver) private readonly queues: QueueUrlResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  @Get("health/live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready(@Res({ passthrough: true }) response: Response): Promise<Record<string, unknown>> {
    const [database, sqs] = await Promise.all([
      check(() => this.orm.em.fork().execute("select 1")),
      check(async () => {
        const queueUrl = await this.queues.resolve(this.config.sqs.wagerQueue);
        await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }));
      }),
    ]);
    const ready = database.status === "up" && sqs.status === "up";
    response.status(ready ? 200 : 503);
    return { status: ready ? "ready" : "not_ready", checks: { database, sqs } };
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  metricsText(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
