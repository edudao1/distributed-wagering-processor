import { WalletNotFoundError } from "../errors";
import type { UnitOfWork } from "../ports/persistence";
import { type LedgerPageView, toLedgerEntryView, toWalletView, type WalletView } from "../views";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((scope) => scope.wallets.findById(walletId), { readOnly: true });
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterSequence = cursor === undefined ? undefined : decodeLedgerCursor(cursor);
    const page = await this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) {
          throw new WalletNotFoundError(walletId);
        }
        return scope.ledger.page(walletId, afterSequence, limit);
      },
      { readOnly: true },
    );
    const last = page.entries.at(-1);
    return {
      items: page.entries.map(({ entry }) => toLedgerEntryView(entry)),
      nextCursor: page.hasMore && last ? encodeLedgerCursor(last.sequence) : null,
    };
  }
}
