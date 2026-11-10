import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../../application/ports/infrastructure";

const HEADER = "x-correlation-id";
const ACCEPTED = /^[A-Za-z0-9._:-]{1,200}$/;

export function correlationIdOf(request: Request): string {
  const value = request.headers[HEADER];
  return typeof value === "string" ? value : randomUUID();
}

export function correlationMiddleware(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const incoming = request.header(HEADER);
    const correlationId = incoming && ACCEPTED.test(incoming) ? incoming : randomUUID();
    request.headers[HEADER] = correlationId;
    response.setHeader(HEADER, correlationId);
    const startedAt = performance.now();
    response.on("finish", () => {
      logger.info(
        {
          correlationId,
          method: request.method,
          path: request.originalUrl.split("?")[0],
          statusCode: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "http request completed",
      );
    });
    next();
  };
}
