import { DomainError, DomainValidationError } from "./shared/domain-error";

export class InvalidMoneyError extends DomainValidationError {
  readonly code = "INVALID_MONEY";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidWagerTransactionError extends DomainValidationError {
  readonly code = "INVALID_WAGER_TRANSACTION";

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, actual: string) {
    super(`currency mismatch: expected ${expected}, received ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(walletId: string) {
    super(`wallet ${walletId} has insufficient funds`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidRetryPolicyError extends DomainError {
  readonly code = "INVALID_RETRY_POLICY";

  constructor(message: string) {
    super(message);
  }
}
