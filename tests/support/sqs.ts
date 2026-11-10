import { randomUUID } from "node:crypto";
import {
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { Json } from "./http";

export function wagerMessage(data: Json, messageId = `msg-${randomUUID()}`): Json {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
  };
}

export async function sendMessage(client: SQSClient, queueUrl: string, body: Json | string, groupId: string): Promise<void> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: text,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

export async function receive(client: SQSClient, queueUrl: string, waitTimeSeconds = 1): Promise<Message[]> {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      AttributeNames: ["All"],
      MessageAttributeNames: ["All"],
    }),
  );
  return response.Messages ?? [];
}

export async function drain(client: SQSClient, queueUrl: string, expected: number, timeoutMs = 20_000): Promise<Message[]> {
  const collected: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (collected.length < expected && Date.now() < deadline) {
    collected.push(...(await receive(client, queueUrl)));
  }
  return collected;
}

export async function queueDepth(client: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const response = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}
