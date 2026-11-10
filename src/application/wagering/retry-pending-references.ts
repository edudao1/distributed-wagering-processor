import { FailureCode } from "../../domain/wagering/failure-code";
import type { ReferenceRetryPolicy } from "../../domain/wagering/reference-retry-policy";
import { WagerSettlement } from "../../domain/wagering/wager-settlement";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import { ConcurrentWriteConflictError, describeError, TransientInfrastructureError } from "../errors";
import type { Clock, IdGenerator, Logger, WageringMetrics } from "../ports/infrastructure";
import type { DuePendingReference, UnitOfWork } from "../ports/persistence";
import { resolveReference } from "./reference-resolver";
import type { SettlementRecorder } from "./settlement-recorder";

export class RetryPendingReferences {
  private readonly settlement = new WagerSettlement();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly recorder: SettlementRecorder,
    private readonly retryPolicy: ReferenceRetryPolicy,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(limit: number): Promise<number> {
    const due = await this.uow.run(
      (scope) => scope.transactions.findDueForReferenceRetry(this.clock.now(), limit),
      { readOnly: true },
    );
    let handled = 0;
    for (const candidate of due) {
      try {
        if (await this.retry(candidate)) {
          handled += 1;
        }
      } catch (error) {
        await this.handleFailure(candidate, error);
      }
    }
    return handled;
  }

  private retry(candidate: DuePendingReference): Promise<boolean> {
    return this.uow.run(async (scope) => {
      const wallet = await scope.wallets.findByIdForUpdate(candidate.walletId);
      const transaction = await scope.transactions.findById(candidate.transactionId);
      const now = this.clock.now();
      if (!wallet || !transaction || !transaction.isDueForReferenceRetry(now)) {
        return false;
      }
      this.metrics.retryScheduled("pending_reference");
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
        correlationId: transaction.id,
        causationId: transaction.id,
        at: now,
      });
      this.logger.info(
        {
          correlationId: transaction.id,
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          status: transaction.status,
          failureCode: transaction.failureCode,
          attempts: transaction.referenceAttempts,
        },
        "pending reference re-evaluated",
      );
      return true;
    });
  }

  private async handleFailure(candidate: DuePendingReference, error: unknown): Promise<void> {
    const fields = { transactionId: candidate.transactionId, walletId: candidate.walletId, err: describeError(error) };
    if (error instanceof TransientInfrastructureError || error instanceof ConcurrentWriteConflictError) {
      this.logger.warn(fields, "pending reference retry hit a transient failure");
      return;
    }
    this.logger.error(fields, "pending reference retry failed permanently");
    try {
      await this.uow.run(async (scope) => {
        await scope.wallets.findByIdForUpdate(candidate.walletId);
        const transaction = await scope.transactions.findById(candidate.transactionId);
        if (!transaction || transaction.isTerminal()) {
          return;
        }
        transaction.fail(FailureCode.ProcessingFailed, this.clock.now());
        scope.transactions.save(transaction);
        this.metrics.transactionSettled(transaction.kind, WagerTransactionStatus.Failed);
      });
    } catch (failure) {
      this.logger.error({ ...fields, err: describeError(failure) }, "could not mark transaction as FAILED");
    }
  }
}
