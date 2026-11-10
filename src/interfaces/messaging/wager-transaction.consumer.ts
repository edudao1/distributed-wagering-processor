import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import {
  describeError,
  ForbiddenProviderError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  RequestValidationError,
  WalletNotFoundError,
} from "../../application/errors";
import type { Logger, PayloadHasher, WageringMetrics } from "../../application/ports/infrastructure";
import { LOGGER, METRICS, PAYLOAD_HASHER, WAGER_TRANSACTION_HANDLER } from "../../application/ports/tokens";
import type { WagerTransactionHandler } from "../../application/wagering/process-wager-transaction";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { DomainValidationError } from "../../domain/shared/domain-error";
import { QueueUrlResolver, SQS_CLIENT } from "../../infrastructure/messaging/sqs-client";
import { type WagerTransactionMessage, wagerTransactionMessageSchema } from "../contracts/wager-transaction.schema";
import { parseOrThrow } from "../contracts/validation";

export type ConsumerDecision =
  | { action: "ack"; reason: "processed" | "duplicate" }
  | { action: "dead-letter"; reason: string }
  | { action: "retry"; delaySeconds: number; reason: string };

const PERMANENT_ERRORS = [
  RequestValidationError,
  DomainValidationError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  WalletNotFoundError,
  ForbiddenProviderError,
];

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function parseMessage(body: string | undefined): WagerTransactionMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? "");
  } catch {
    throw new RequestValidationError("message body is not valid JSON", [], "INVALID_MESSAGE");
  }
  return parseOrThrow(wagerTransactionMessageSchema, json, "INVALID_MESSAGE");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QueueUrlResolver) private readonly queues: QueueUrlResolver,
    @Inject(WAGER_TRANSACTION_HANDLER) private readonly handler: WagerTransactionHandler,
    @Inject(PAYLOAD_HASHER) private readonly hasher: PayloadHasher,
    @Inject(METRICS) private readonly metrics: WageringMetrics,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.sqs.consumerEnabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loops = Array.from({ length: this.config.sqs.consumerConcurrency }, () => this.poll());
    this.logger.info({ concurrency: this.config.sqs.consumerConcurrency }, "sqs consumer started");
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.abort.abort();
    const drained = Promise.allSettled(this.loops);
    const timeout = sleep(this.config.shutdownTimeoutMs).then(() => "timeout" as const);
    const result = await Promise.race([drained.then(() => "drained" as const), timeout]);
    this.logger.info({ result }, "sqs consumer stopped");
  }

  async handle(message: Message): Promise<ConsumerDecision> {
    const decision = await this.decide(message);
    await this.apply(message, decision);
    return decision;
  }

  async decide(message: Message): Promise<ConsumerDecision> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    let envelope: WagerTransactionMessage;
    try {
      envelope = parseMessage(message.Body);
    } catch (error) {
      this.logger.warn({ sqsMessageId: message.MessageId, err: describeError(error) }, "invalid message received");
      return { action: "dead-letter", reason: "INVALID_MESSAGE" };
    }

    const { idempotencyKey, ...payload } = envelope.data;
    const correlationId = envelope.correlationId ?? envelope.messageId;
    const log = this.logger.child({
      correlationId,
      messageId: envelope.messageId,
      walletId: payload.walletId,
      providerId: payload.providerId,
    });

    try {
      const result = await this.handler.execute(
        { ...payload, idempotencyKey },
        {
          correlationId,
          inbox: {
            consumerName: this.config.sqs.consumerName,
            messageId: envelope.messageId,
            payloadHash: this.hasher.hash({ type: envelope.type, data: envelope.data }),
          },
        },
      );
      return { action: "ack", reason: result.outcome === "duplicate-message" ? "duplicate" : "processed" };
    } catch (error) {
      const code = errorCode(error);
      if (PERMANENT_ERRORS.some((type) => error instanceof type)) {
        log.warn({ code, err: describeError(error) }, "permanent failure; sending message to the DLQ");
        return { action: "dead-letter", reason: code };
      }
      if (receiveCount >= this.config.sqs.maxReceives) {
        log.error({ code, receiveCount, err: describeError(error) }, "retry budget exhausted; sending to the DLQ");
        return { action: "dead-letter", reason: "MAX_RECEIVES_EXCEEDED" };
      }
      const delaySeconds = this.backoff(receiveCount);
      log.warn({ code, receiveCount, delaySeconds, err: describeError(error) }, "transient failure; retry scheduled");
      return { action: "retry", delaySeconds, reason: code };
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      let messages: Message[] = [];
      try {
        const queueUrl = await this.queues.resolve(this.config.sqs.wagerQueue);
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.config.sqs.batchSize,
            WaitTimeSeconds: this.config.sqs.waitTimeSeconds,
            VisibilityTimeout: this.config.sqs.visibilityTimeoutSeconds,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (!this.running) {
          break;
        }
        this.logger.warn({ err: describeError(error) }, "failed to receive messages");
        await sleep(1_000);
        continue;
      }
      for (let index = 0; index < messages.length; index += 1) {
        if (!this.running) {
          await this.releaseAll(messages.slice(index));
          break;
        }
        const message = messages[index];
        if (message) {
          await this.handle(message);
        }
      }
    }
  }

  private async apply(message: Message, decision: ConsumerDecision): Promise<void> {
    try {
      const queueUrl = await this.queues.resolve(this.config.sqs.wagerQueue);
      switch (decision.action) {
        case "ack":
          await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
          return;
        case "retry":
          this.metrics.retryScheduled("sqs");
          await this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: decision.delaySeconds,
            }),
          );
          return;
        case "dead-letter":
          await this.deadLetter(queueUrl, message, decision.reason);
          return;
      }
    } catch (error) {
      this.logger.warn(
        { sqsMessageId: message.MessageId, action: decision.action, err: describeError(error) },
        "could not settle message with SQS; it will be redelivered and deduplicated by the inbox",
      );
    }
  }

  private async deadLetter(queueUrl: string, message: Message, reason: string): Promise<void> {
    const dlqUrl = await this.queues.resolve(this.config.sqs.wagerDlq);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body || "{}",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: reason },
          sourceMessageId: { DataType: "String", StringValue: message.MessageId ?? "unknown" },
        },
      }),
    );
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    this.metrics.messageDeadLettered(reason);
  }

  private async releaseAll(messages: Message[]): Promise<void> {
    const queueUrl = await this.queues.resolve(this.config.sqs.wagerQueue);
    await Promise.allSettled(
      messages.map((message) =>
        this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        ),
      ),
    );
  }

  private backoff(receiveCount: number): number {
    const { retryBaseDelaySeconds, retryMaxDelaySeconds } = this.config.sqs;
    return Math.min(retryBaseDelaySeconds * 2 ** Math.max(0, receiveCount - 1), retryMaxDelaySeconds);
  }
}
