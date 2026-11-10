import { CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../config/app-config";
import { QueueUrlResolver } from "./sqs-client";

async function createFifoQueue(client: SQSClient, resolver: QueueUrlResolver, name: string): Promise<string> {
  await client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true" } }));
  return resolver.resolve(name);
}

export async function ensureQueues(client: SQSClient, config: AppConfig["sqs"]): Promise<void> {
  const resolver = new QueueUrlResolver(client, config.endpoint);
  const dlqUrl = await createFifoQueue(client, resolver, config.wagerDlq);
  const mainUrl = await createFifoQueue(client, resolver, config.wagerQueue);
  const eventsUrl = await createFifoQueue(client, resolver, config.eventsQueue);

  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
  );
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) {
    throw new Error(`could not resolve the ARN of ${config.wagerDlq}`);
  }

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: mainUrl,
      Attributes: {
        VisibilityTimeout: String(config.visibilityTimeoutSeconds),
        ContentBasedDeduplication: "false",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(config.maxReceives + 1),
        }),
      },
    }),
  );
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      Attributes: { MessageRetentionPeriod: "1209600" },
    }),
  );
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: eventsUrl,
      Attributes: { ContentBasedDeduplication: "false" },
    }),
  );
}
