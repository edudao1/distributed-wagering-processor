import { z } from "zod";
import { isSubmittableKind, WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";

const identifier = (max: number) => z.string().min(1).max(max);

export const uuidSchema = z.string().uuid();

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const idempotencyKeySchema = identifier(255);

export const wagerTransactionPayloadSchema = z.object({
  providerId: identifier(100),
  externalTransactionId: identifier(200),
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifier(200),
  gameId: identifier(200),
  kind: z.nativeEnum(WagerTransactionKind).refine(isSubmittableKind, {
    message: "OPENING is internal and cannot be submitted",
  }),
  money: moneySchema,
  referenceExternalTransactionId: identifier(200).optional(),
});

export const wagerTransactionMessageSchema = z.object({
  messageId: identifier(200),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: identifier(200).optional(),
  data: wagerTransactionPayloadSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerTransactionPayload = z.infer<typeof wagerTransactionPayloadSchema>;
export type WagerTransactionMessage = z.infer<typeof wagerTransactionMessageSchema>;

export const createWalletSchema = z.object({
  playerId: uuidSchema,
  initialBalance: moneySchema,
});

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
