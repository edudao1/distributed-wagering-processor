import { WalletNotFoundError } from "../errors";
import type { Logger, WageringMetrics } from "../ports/infrastructure";
import type { UnitOfWork } from "../ports/persistence";
import type { ReconciliationView } from "../views";

export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string, context: { correlationId: string }): Promise<ReconciliationView> {
    const { wallet, summary } = await this.uow.run(
      async (scope) => {
        const found = await scope.wallets.findById(walletId);
        if (!found) {
          throw new WalletNotFoundError(walletId);
        }
        return { wallet: found, summary: await scope.ledger.summarize(walletId, found.currency) };
      },
      { isolation: "repeatable-read", readOnly: true },
    );

    const calculated = summary.credits.subtract(summary.debits);
    const difference = wallet.balance.subtract(calculated);
    const lastEntryMatches = summary.lastBalanceAfter
      ? summary.lastBalanceAfter.equals(wallet.balance)
      : wallet.balance.isZero();
    const consistent = difference.isZero() && lastEntryMatches;

    this.metrics.reconciliationChecked(consistent);
    if (!consistent) {
      this.logger.warn(
        {
          correlationId: context.correlationId,
          walletId,
          checkedEntries: summary.entries,
          lastEntryMatches,
        },
        "wallet reconciliation found a divergence",
      );
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entries,
    };
  }
}
