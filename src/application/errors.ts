export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RequestValidationError extends ApplicationError {
  readonly code: string;

  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = [],
    code = "INVALID_PAYLOAD",
  ) {
    super(message);
    this.code = code;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(walletId: string) {
    super(`wallet ${walletId} was not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";

  constructor(reference: string) {
    super(`transaction ${reference} was not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export type IdempotencyConflictReason = "PAYLOAD_MISMATCH" | "EXTERNAL_ID_REUSED";

export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(
    public readonly reason: IdempotencyConflictReason,
    idempotencyKey: string,
  ) {
    super(
      reason === "PAYLOAD_MISMATCH"
        ? `idempotency key ${idempotencyKey} was already used with a different payload`
        : `the external transaction id was already submitted under another idempotency key`,
    );
  }
}

export class InboxPayloadConflictError extends ApplicationError {
  readonly code = "INBOX_PAYLOAD_CONFLICT";

  constructor(messageId: string) {
    super(`message ${messageId} was already received with a different payload`);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("cursor is malformed");
  }
}

export class ForbiddenProviderError extends ApplicationError {
  readonly code = "FORBIDDEN_PROVIDER";

  constructor(providerId: string) {
    super(`the authenticated principal cannot act for provider ${providerId}`);
  }
}

export class ConcurrentWriteConflictError extends ApplicationError {
  readonly code = "CONCURRENT_WRITE_CONFLICT";

  constructor(
    public readonly constraint: string | undefined,
    cause?: unknown,
  ) {
    super(`a concurrent write violated ${constraint ?? "a unique constraint"}`, { cause });
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_INFRASTRUCTURE_FAILURE";

  constructor(
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(`transient infrastructure failure: ${reason}`, { cause });
  }
}

export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
