import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/bootstrap";
import type { AppConfig } from "../../src/config/app-config";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { ensureQueues } from "../../src/infrastructure/messaging/sqs-topology";
import { ensureSchema } from "./environment";

export interface TestApplication {
  app: INestApplication;
  config: AppConfig;
  baseUrl: string;
  close(): Promise<void>;
}

export async function prepareInfrastructure(config: AppConfig): Promise<void> {
  await ensureSchema();
  const client = createSqsClient(config.sqs);
  try {
    await ensureQueues(client, config.sqs);
  } finally {
    client.destroy();
  }
}

export async function startApplication(config: AppConfig): Promise<TestApplication> {
  await prepareInfrastructure(config);
  const app = await createApplication(config);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return {
    app,
    config,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}
