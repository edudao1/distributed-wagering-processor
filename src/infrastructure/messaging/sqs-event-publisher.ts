import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import type { EventPublisher } from "../../application/ports/infrastructure";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { QueueUrlResolver, SQS_CLIENT } from "./sqs-client";

@Injectable()
export class SqsEventPublisher implements EventPublisher {
  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(QueueUrlResolver) private readonly queues: QueueUrlResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl = await this.queues.resolve(this.config.sqs.eventsQueue);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: message.eventType },
          eventId: { DataType: "String", StringValue: message.id },
        },
      }),
    );
  }
}
