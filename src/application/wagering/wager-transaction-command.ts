import type { Money, MoneyProps } from "../../domain/money/money";
import type { SubmittableKind } from "../../domain/wagering/wager-transaction-kind";

export interface WagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function businessPayload(command: WagerTransactionCommand, money: Money): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: money.toJSON(),
  };
  if (command.referenceExternalTransactionId !== undefined) {
    payload.referenceExternalTransactionId = command.referenceExternalTransactionId;
  }
  return payload;
}
