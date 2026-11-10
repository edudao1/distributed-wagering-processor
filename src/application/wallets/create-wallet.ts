import type { EventContext } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransactionProcessed, WalletBalanceChanged } from "../../domain/wagering/events";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import { Wallet } from "../../domain/wallet/wallet";
import { ConcurrentWriteConflictError, WalletAlreadyExistsError } from "../errors";
import type { Clock, IdGenerator, Logger, PayloadHasher, WageringMetrics } from "../ports/infrastructure";
import type { UnitOfWork } from "../ports/persistence";
import { toWalletView, type WalletView } from "../views";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export const WALLET_UNIQUE_CONSTRAINT = "uq_wallets_player_currency";

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly hasher: PayloadHasher,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(command: CreateWalletCommand, context: { correlationId: string }): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    try {
      const view = await this.uow.run(async (scope) => {
        const existing = await scope.wallets.findByPlayerAndCurrency(command.playerId, initialBalance.currency);
        if (existing) {
          throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
        }
        const now = this.clock.now();
        const walletId = this.ids.next();
        const opening = initialBalance.isPositive()
          ? { transactionId: this.ids.next(), entryId: this.ids.next() }
          : undefined;
        const wallet = Wallet.open({ id: walletId, playerId: command.playerId, initialBalance, at: now, opening });
        const entries = scope.wallets.save(wallet);
        if (opening) {
          const transaction = WagerTransaction.opening({
            id: opening.transactionId,
            walletId,
            playerId: command.playerId,
            money: initialBalance,
            payloadHash: this.hasher.hash({
              kind: WagerTransactionKind.Opening,
              walletId,
              playerId: command.playerId,
              money: initialBalance.toJSON(),
            }),
            createdAt: now,
          });
          transaction.markProcessed(undefined, now, wallet.balance);
          scope.transactions.save(transaction);
          const eventContext = (): EventContext => ({
            eventId: this.ids.next(),
            correlationId: context.correlationId,
            occurredAt: now,
          });
          scope.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, eventContext())));
          for (const entry of entries) {
            scope.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, eventContext())));
          }
          this.metrics.transactionSettled(transaction.kind, transaction.status);
        }
        return toWalletView(wallet);
      });
      this.logger.info({ correlationId: context.correlationId, walletId: view.id }, "wallet created");
      return view;
    } catch (error) {
      if (error instanceof ConcurrentWriteConflictError && error.constraint === WALLET_UNIQUE_CONSTRAINT) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
