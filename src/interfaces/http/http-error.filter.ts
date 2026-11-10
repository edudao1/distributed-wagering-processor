import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ConcurrentWriteConflictError,
  describeError,
  ForbiddenProviderError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  InvalidCursorError,
  RequestValidationError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors";
import type { Logger } from "../../application/ports/infrastructure";
import { LOGGER } from "../../application/ports/tokens";
import { DomainValidationError } from "../../domain/shared/domain-error";
import { correlationIdOf } from "./correlation";

export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

interface MappedError {
  status: number;
  body: HttpErrorBody;
  retryAfterSeconds?: number;
}

function mapped(status: number, code: string, message: string, retryable: boolean, details?: unknown): MappedError {
  return { status, body: { error: { code, message, retryable, ...(details !== undefined ? { details } : {}) } } };
}

function isBodyParserError(error: unknown): error is { type: string; message: string } {
  return typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed";
}

export function mapError(error: unknown): MappedError {
  if (error instanceof RequestValidationError) {
    return mapped(400, error.code, error.message, false, error.issues);
  }
  if (error instanceof DomainValidationError) {
    return mapped(400, "INVALID_PAYLOAD", error.message, false, { reason: error.code });
  }
  if (error instanceof InvalidCursorError) {
    return mapped(400, error.code, error.message, false);
  }
  if (isBodyParserError(error)) {
    return mapped(400, "INVALID_PAYLOAD", "request body is not valid JSON", false);
  }
  if (error instanceof ForbiddenProviderError) {
    return mapped(403, error.code, error.message, false);
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return mapped(404, error.code, error.message, false);
  }
  if (error instanceof IdempotencyConflictError) {
    return mapped(409, error.code, error.message, false, { reason: error.reason });
  }
  if (error instanceof InboxPayloadConflictError || error instanceof WalletAlreadyExistsError) {
    return mapped(409, error.code, error.message, false);
  }
  if (error instanceof TransientInfrastructureError || error instanceof ConcurrentWriteConflictError) {
    return { ...mapped(503, "TEMPORARILY_UNAVAILABLE", "retry the request later", true), retryAfterSeconds: 1 };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 404 ? "NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : status === 400 ? "INVALID_PAYLOAD" : "HTTP_ERROR";
    return mapped(status, code, error.message, status >= 500);
  }
  return mapped(500, "INTERNAL_ERROR", "unexpected error", true);
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const result = mapError(exception);
    const fields = {
      correlationId: correlationIdOf(request),
      statusCode: result.status,
      code: result.body.error.code,
      err: describeError(exception),
    };
    if (result.status >= 500) {
      this.logger.error(fields, "request failed");
    } else {
      this.logger.debug(fields, "request rejected");
    }
    if (result.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(result.retryAfterSeconds));
    }
    response.status(result.status).json(result.body);
  }
}
