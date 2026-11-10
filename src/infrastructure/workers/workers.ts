import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { PublishOutboxBatch } from "../../application/messaging/publish-outbox";
import type { Logger } from "../../application/ports/infrastructure";
import { LOGGER } from "../../application/ports/tokens";
import { RetryPendingReferences } from "../../application/wagering/retry-pending-references";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { BackgroundLoop } from "./background-loop";

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: BackgroundLoop;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutboxBatch) publisher: PublishOutboxBatch,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.loop = new BackgroundLoop(
      "outbox-publisher",
      config.outbox.intervalMs,
      async () => {
        const claimed = await publisher.execute();
        await publisher.refreshBacklog();
        return claimed;
      },
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.outbox.enabled) {
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: BackgroundLoop;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RetryPendingReferences) retry: RetryPendingReferences,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.loop = new BackgroundLoop(
      "pending-reference",
      config.pendingReference.intervalMs,
      () => retry.execute(config.pendingReference.batchSize),
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.pendingReference.enabled) {
      this.loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}
