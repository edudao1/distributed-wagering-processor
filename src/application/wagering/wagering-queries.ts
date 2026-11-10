import { TransactionNotFoundError } from "../errors";
import type { UnitOfWork } from "../ports/persistence";
import { toTransactionView, type WagerTransactionView } from "../views";

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.run((scope) => scope.transactions.findById(transactionId), { readOnly: true });
    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }
    return toTransactionView(transaction);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.run(
      (scope) => scope.transactions.findByExternalId(providerId, externalTransactionId),
      { readOnly: true },
    );
    if (!transaction) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return toTransactionView(transaction);
  }
}
