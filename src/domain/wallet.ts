import { DomainError } from './errors';
import { Money } from './money';
import { WalletLedgerEntry, type LedgerDirection } from './ledger-entry';

export interface WalletState {
  id: string; playerId: string; balance: Money; version: number; createdAt: Date; updatedAt: Date;
}
interface Movement { entryId: string; transactionId: string; money: Money; at: Date }

export class Wallet {
  private constructor(private readonly state: WalletState) {}
  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new DomainError('INVALID_AMOUNT');
    const at = props.at ?? new Date();
    return Wallet.rehydrate({ id: props.id, playerId: props.playerId,
      balance: props.initialBalance, version: 1, createdAt: at, updatedAt: at });
  }
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state, createdAt: new Date(state.createdAt), updatedAt: new Date(state.updatedAt) });
  }
  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.state.balance.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }

  debit(props: Movement, reversal = false): WalletLedgerEntry {
    return this.move('DEBIT', props, reversal);
  }
  credit(props: Movement): WalletLedgerEntry { return this.move('CREDIT', props, false); }
  /** Crédito inicial já está no saldo/version 1; não aplica o saldo novamente. */
  openingEntry(props: { entryId: string; transactionId: string }): WalletLedgerEntry | undefined {
    if (this.balance.isZero()) return undefined;
    return WalletLedgerEntry.create({ id: props.entryId, walletId: this.id,
      transactionId: props.transactionId, direction: 'CREDIT', money: this.balance,
      balanceBefore: Money.zero(this.currency), balanceAfter: this.balance, createdAt: this.createdAt });
  }
  private move(direction: LedgerDirection, props: Movement, reversal: boolean): WalletLedgerEntry {
    if (!props.money.isPositive()) throw new DomainError('INVALID_AMOUNT');
    const before = this.balance;
    const after = direction === 'CREDIT' ? before.add(props.money) : before.subtract(props.money);
    if (after.isNegative()) throw new DomainError(reversal ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
    const entry = WalletLedgerEntry.create({ id: props.entryId, walletId: this.id,
      transactionId: props.transactionId, direction, money: props.money,
      balanceBefore: before, balanceAfter: after, createdAt: props.at });
    this.state.balance = after;
    this.state.version += 1;
    this.state.updatedAt = new Date(props.at);
    return entry;
  }
}
