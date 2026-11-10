import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { describeError } from "../errors";
import type { Clock, EventPublisher, Logger, WageringMetrics } from "../ports/infrastructure";
import type { OutboxStore } from "../ports/persistence";

export interface PublishOutboxOptions {
  owner: string;
  batchSize: number;
  leaseMs: number;
}

export class PublishOutboxBatch {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly options: PublishOutboxOptions,
  ) {}

  async execute(): Promise<number> {
    const claimed = await this.store.claim(this.options.owner, this.options.batchSize, this.options.leaseMs);
    let published = 0;
    for (const message of claimed) {
      try {
        await this.publisher.publish(message);
      } catch (error) {
        await this.retryLater(message, error);
        continue;
      }
      message.markPublished(this.clock.now());
      published += 1;
      try {
        await this.store.markPublished(message);
      } catch (error) {
        this.logger.warn(
          { eventId: message.id, eventType: message.eventType, err: describeError(error) },
          "event published but not marked; it will be republished after the lease expires",
        );
      }
    }
    if (published > 0) {
      this.metrics.outboxPublished(published);
    }
    return claimed.length;
  }

  async refreshBacklog(): Promise<void> {
    const backlog = await this.store.backlog();
    this.metrics.outboxBacklog(backlog.lagSeconds, backlog.pending);
  }

  private async retryLater(message: OutboxMessage, error: unknown): Promise<void> {
    message.scheduleRetry(this.clock.now());
    this.metrics.retryScheduled("outbox");
    this.logger.warn(
      {
        eventId: message.id,
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        attempts: message.attempts,
        err: describeError(error),
      },
      "event publication failed; retry scheduled",
    );
    try {
      await this.store.release(message, this.options.owner, describeError(error));
    } catch (releaseError) {
      this.logger.warn({ eventId: message.id, err: describeError(releaseError) }, "could not release outbox lease");
    }
  }
}
