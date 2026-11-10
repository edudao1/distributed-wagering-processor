import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { LedgerPageView, ReconciliationView, WalletView } from "../../application/views";
import { CreateWallet } from "../../application/wallets/create-wallet";
import { ReconcileWallet } from "../../application/wallets/reconcile-wallet";
import { WalletQueries } from "../../application/wallets/wallet-queries";
import { createWalletSchema, ledgerQuerySchema, uuidSchema } from "../contracts/wager-transaction.schema";
import { parseOrThrow } from "../contracts/validation";
import { correlationIdOf } from "./correlation";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() request: Request): Promise<WalletView> {
    const input = parseOrThrow(createWalletSchema, body);
    return this.createWallet.execute(input, { correlationId: correlationIdOf(request) });
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.queries.getWallet(parseOrThrow(uuidSchema, walletId));
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query() query: unknown): Promise<LedgerPageView> {
    const id = parseOrThrow(uuidSchema, walletId);
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query);
    return this.queries.listLedger(id, cursor, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string, @Req() request: Request): Promise<ReconciliationView> {
    return this.reconcileWallet.execute(parseOrThrow(uuidSchema, walletId), {
      correlationId: correlationIdOf(request),
    });
  }
}
