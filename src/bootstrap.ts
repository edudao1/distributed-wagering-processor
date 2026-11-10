import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { Logger } from "./application/ports/infrastructure";
import { LOGGER } from "./application/ports/tokens";
import type { AppConfig } from "./config/app-config";
import { NestLoggerAdapter } from "./infrastructure/observability/logger";
import { correlationMiddleware } from "./interfaces/http/correlation";

export async function createApplication(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), {
    bufferLogs: true,
    abortOnError: false,
  });
  const logger = app.get<Logger>(LOGGER);
  app.useLogger(new NestLoggerAdapter(logger));
  app.use(correlationMiddleware(logger));
  return app;
}
