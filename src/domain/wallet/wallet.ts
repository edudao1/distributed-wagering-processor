import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from "../errors";
import { LedgerDirection } from "../ledger/ledger-direction";
import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: {
    transactionId: string;
    entryId: string;
  };
}

export class Wallet {
  private uncommittedEntries: WalletLedgerEntry[] = [];

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError("initial balance must not be negative");
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      Money.zero(initialBalance.currency),
      1,
      props.at,
      props.at,
    );
    if (initialBalance.isPositive()) {
      if (!props.opening) {
        throw new InvalidWalletError("a positive initial balance requires an opening transaction");
      }
      wallet.apply(LedgerDirection.Credit, {
        entryId: props.opening.entryId,
        transactionId: props.opening.transactionId,
        money: initialBalance,
        at: props.at,
      });
    }
    return wallet;
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.change(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement);
    return this.change(LedgerDirection.Credit, movement);
  }

  pullUncommittedEntries(): WalletLedgerEntry[] {
    const entries = this.uncommittedEntries;
    this.uncommittedEntries = [];
    return entries;
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private change(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const entry = this.apply(direction, movement);
    this._version += 1;
    return entry;
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    if (this.uncommittedEntries.some((entry) => entry.transactionId === movement.transactionId)) {
      throw new InvalidWalletError(`transaction ${movement.transactionId} already moved wallet ${this.id}`);
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });
    this._balance = after;
    this._updatedAt = movement.at;
    this.uncommittedEntries.push(entry);
    return entry;
  }

  private assertMovement(movement: WalletMovement): void {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletError("a balance movement must be greater than zero");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
