import { loadConfig } from "../src/config/app-config";
import { createSqsClient } from "../src/infrastructure/messaging/sqs-client";
import { ensureQueues } from "../src/infrastructure/messaging/sqs-topology";

const config = loadConfig();
const client = createSqsClient(config.sqs);

try {
  await ensureQueues(client, config.sqs);
  console.log(
    JSON.stringify({
      level: "info",
      message: "queues ready",
      queues: [config.sqs.wagerQueue, config.sqs.wagerDlq, config.sqs.eventsQueue],
    }),
  );
} finally {
  client.destroy();
}
