import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../config/app-config";

export const SQS_CLIENT = Symbol("SQS_CLIENT");

export function createSqsClient(config: AppConfig["sqs"]): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 3,
  });
}

export class QueueUrlResolver {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly client: SQSClient,
    private readonly endpoint: string | undefined,
  ) {}

  resolve(queueName: string): Promise<string> {
    const cached = this.cache.get(queueName);
    if (cached) {
      return cached;
    }
    const pending = this.lookup(queueName);
    this.cache.set(queueName, pending);
    pending.catch(() => this.cache.delete(queueName));
    return pending;
  }

  private async lookup(queueName: string): Promise<string> {
    const response = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!response.QueueUrl) {
      throw new Error(`queue ${queueName} has no URL`);
    }
    if (!this.endpoint) {
      return response.QueueUrl;
    }
    const url = new URL(response.QueueUrl);
    return `${this.endpoint.replace(/\/$/, "")}${url.pathname}`;
  }
}
