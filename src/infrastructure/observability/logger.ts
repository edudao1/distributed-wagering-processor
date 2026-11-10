import type { LoggerService } from "@nestjs/common";
import { type Logger as PinoInstance, pino } from "pino";
import type { LogFields, Logger } from "../../application/ports/infrastructure";
import type { AppConfig } from "../../config/app-config";

const REDACTED_PATHS = [
  "money",
  "*.money",
  "balance",
  "*.balance",
  "payload",
  "*.payload",
  "body",
  "*.body",
  "headers.authorization",
  "*.headers.authorization",
];

export class PinoLogger implements Logger {
  private constructor(private readonly delegate: PinoInstance) {}

  static create(config: Pick<AppConfig, "logLevel" | "instanceId">): PinoLogger {
    return new PinoLogger(
      pino({
        level: config.logLevel,
        base: { service: "wagering-processor", instanceId: config.instanceId },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
      }),
    );
  }

  debug(fields: LogFields, message: string): void {
    this.delegate.debug(fields, message);
  }

  info(fields: LogFields, message: string): void {
    this.delegate.info(fields, message);
  }

  warn(fields: LogFields, message: string): void {
    this.delegate.warn(fields, message);
  }

  error(fields: LogFields, message: string): void {
    this.delegate.error(fields, message);
  }

  child(bindings: LogFields): Logger {
    return new PinoLogger(this.delegate.child(bindings));
  }
}

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.info(this.context(optional), String(message));
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.logger.error(this.context(optional), String(message));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn(this.context(optional), String(message));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(this.context(optional), String(message));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(this.context(optional), String(message));
  }

  private context(optional: unknown[]): LogFields {
    const last = optional.at(-1);
    return typeof last === "string" ? { context: last } : {};
  }
}
