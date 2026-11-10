export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export function isSubmittableKind(kind: WagerTransactionKind): kind is SubmittableKind {
  return kind !== WagerTransactionKind.Opening;
}
