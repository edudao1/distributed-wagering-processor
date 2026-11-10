import type { ReferenceResolution } from "../../domain/wagering/wager-settlement";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { TransactionScope } from "../ports/persistence";

export async function resolveReference(
  scope: TransactionScope,
  transaction: WagerTransaction,
): Promise<ReferenceResolution> {
  const externalId = transaction.referenceExternalTransactionId;
  if (externalId === undefined) {
    return { type: "none" };
  }
  const target = await scope.transactions.findByExternalId(transaction.providerId, externalId);
  if (!target) {
    return { type: "missing" };
  }
  const alreadyReversed = transaction.isReversal() ? await scope.transactions.hasProcessedReversal(target.id) : false;
  return { type: "found", transaction: target, alreadyReversed };
}
