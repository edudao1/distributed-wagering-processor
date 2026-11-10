export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
  AlreadyReversed = "ALREADY_REVERSED",
  ProcessingFailed = "PROCESSING_FAILED",
}
