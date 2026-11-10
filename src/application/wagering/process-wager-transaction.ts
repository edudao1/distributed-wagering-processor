import { InboxMessage } from "../../domain/messaging/inbox-message";
import { Money } from "../../domain/money/money";
import type { ReferenceRetryPolicy } from "../../domain/wagering/reference-retry-policy";
import { WagerSettlement } from "../../domain/wagering/wager-settlement";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import {
  ConcurrentWriteConflictError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  WalletNotFoundError,
} from "../errors";
import type { Clock, IdGenerator, Logger, PayloadHasher, WageringMetrics } from "../ports/infrastructure";
import type { TransactionScope, UnitOfWork } from "../ports/persistence";
import { toSubmissionView, type WagerSubmissionView } from "../views";
import { resolveReference } from "./reference-resolver";
import type { SettlementRecorder } from "./settlement-recorder";
import { businessPayload, type WagerTransactionCommand } from "./wager-transaction-command";

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessingContext {
  correlationId: string;
  inbox?: InboxContext;
}

export type ProcessWagerResult =
  | { outcome: "completed"; view: WagerSubmissionView }
  | { outcome: "duplicate-message" };

export interface WagerTransactionHandler {
  execute(command: WagerTransactionCommand, context: ProcessingContext): Promise<ProcessWagerResult>;
}

const MAX_WRITE_CONFLICT_ATTEMPTS = 3;

export class ProcessWagerTransaction implements WagerTransactionHandler {
  private readonly settlement = new WagerSettlement();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly hasher: PayloadHasher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly recorder: SettlementRecorder,
    private readonly retryPolicy: ReferenceRetryPolicy,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(command: WagerTransactionCommand, context: ProcessingContext): Promise<ProcessWagerResult> {
    const startedAt = performance.now();
    const money = Money.from(command.money);
    const payloadHash = this.hasher.hash(businessPayload(command, money));
    const source = context.inbox ? "sqs" : "http";
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.uow.run((scope) => this.process(scope, command, money, payloadHash, context));
        this.observe(result, command, context, source, startedAt);
        return result;
      } catch (error) {
        if (error instanceof ConcurrentWriteConflictError && attempt < MAX_WRITE_CONFLICT_ATTEMPTS) {
          this.metrics.retryScheduled("write_conflict");
          continue;
        }
        if (error instanceof IdempotencyConflictError) {
          this.metrics.idempotencyConflict(error.reason);
        }
        this.metrics.processingObserved(source, "error", (performance.now() - startedAt) / 1000);
        throw error;
      }
    }
  }

  private async process(
    scope: TransactionScope,
    command: WagerTransactionCommand,
    money: Money,
    payloadHash: string,
    context: ProcessingContext,
  ): Promise<ProcessWagerResult> {
    const now = this.clock.now();
    if (context.inbox) {
      const inbox = InboxMessage.receive({ ...context.inbox, receivedAt: now });
      inbox.markProcessed(now);
      const recorded = await scope.inbox.record(inbox);
      if (!recorded.recorded) {
        if (!recorded.existing.matchesPayload(context.inbox.payloadHash)) {
          throw new InboxPayloadConflictError(context.inbox.messageId);
        }
        this.metrics.duplicateDetected("inbox");
        return { outcome: "duplicate-message" };
      }
    }

    const known = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (known) {
      return this.replay(known, payloadHash);
    }

    const wallet = await scope.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const raced = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (raced) {
      return this.replay(raced, payloadHash);
    }
    const sameExternalId = await scope.transactions.findByExternalId(command.providerId, command.externalTransactionId);
    if (sameExternalId) {
      throw new IdempotencyConflictError("EXTERNAL_ID_REUSED", command.idempotencyKey);
    }

    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });
    const reference = await resolveReference(scope, transaction);
    const outcome = this.settlement.settle({
      transaction,
      wallet,
      reference,
      retryPolicy: this.retryPolicy,
      ledgerEntryId: this.ids.next(),
      at: now,
    });
    this.recorder.record(scope, {
      transaction,
      wallet,
      outcome,
      correlationId: context.correlationId,
      causationId: context.inbox?.messageId,
      at: now,
    });
    return { outcome: "completed", view: toSubmissionView(transaction, false) };
  }

  private replay(existing: WagerTransaction, payloadHash: string): ProcessWagerResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError("PAYLOAD_MISMATCH", existing.idempotencyKey);
    }
    this.metrics.duplicateDetected("idempotency_key");
    return { outcome: "completed", view: toSubmissionView(existing, true) };
  }

  private observe(
    result: ProcessWagerResult,
    command: WagerTransactionCommand,
    context: ProcessingContext,
    source: string,
    startedAt: number,
  ): void {
    const seconds = (performance.now() - startedAt) / 1000;
    const outcome = result.outcome === "completed" ? result.view.status : "DUPLICATE_MESSAGE";
    this.metrics.processingObserved(source, outcome, seconds);
    this.logger.info(
      {
        correlationId: context.correlationId,
        messageId: context.inbox?.messageId,
        transactionId: result.outcome === "completed" ? result.view.transactionId : undefined,
        walletId: command.walletId,
        providerId: command.providerId,
        kind: command.kind,
        status: outcome,
        failureCode: result.outcome === "completed" ? result.view.failureCode : undefined,
        idempotentReplay: result.outcome === "completed" ? result.view.idempotentReplay : true,
        durationMs: Math.round(seconds * 1000),
      },
      "wager transaction handled",
    );
  }
}
