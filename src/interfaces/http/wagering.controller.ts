import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { WAGER_TRANSACTION_HANDLER } from "../../application/ports/tokens";
import type { WagerTransactionHandler } from "../../application/wagering/process-wager-transaction";
import { WageringQueries } from "../../application/wagering/wagering-queries";
import type { WagerSubmissionView, WagerTransactionView } from "../../application/views";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import {
  idempotencyKeySchema,
  uuidSchema,
  wagerTransactionPayloadSchema,
} from "../contracts/wager-transaction.schema";
import { parseOrThrow } from "../contracts/validation";
import { principalOf } from "./auth";
import { correlationIdOf } from "./correlation";

export function httpStatusFor(view: WagerSubmissionView): number {
  switch (view.status) {
    case WagerTransactionStatus.Processed:
      return view.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(WAGER_TRANSACTION_HANDLER) private readonly handler: WagerTransactionHandler,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerSubmissionView> {
    const key = parseOrThrow(idempotencyKeySchema, idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
    const payload = parseOrThrow(wagerTransactionPayloadSchema, body);
    principalOf(request).assertCanActFor(payload.providerId);
    const result = await this.handler.execute(
      { ...payload, idempotencyKey: key },
      { correlationId: correlationIdOf(request) },
    );
    if (result.outcome !== "completed") {
      throw new Error("HTTP submissions never go through the inbox");
    }
    response.status(httpStatusFor(result.view));
    return result.view;
  }

  @Get("wagering/transactions/:transactionId")
  getById(@Param("transactionId") transactionId: string): Promise<WagerTransactionView> {
    return this.queries.getById(parseOrThrow(uuidSchema, transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}
