import { DomainError } from './errors';
import { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';
export interface LedgerEntryState {
  id: string; walletId: string; transactionId: string; direction: LedgerDirection;
  money: Money; balanceBefore: Money; balanceAfter: Money; createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerEntryState>) { Object.freeze(this); }
  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(Object.freeze({ ...state, createdAt: new Date(state.createdAt) }));
    if (!state.money.isPositive() || state.balanceBefore.isNegative()
      || state.balanceAfter.isNegative() || !entry.isBalanced()) throw new DomainError('INVALID_AMOUNT');
    return entry;
  }
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(Object.freeze({ ...state, createdAt: new Date(state.createdAt) }));
  }
  get id(): string { return this.state.id; }
  get walletId(): string { return this.state.walletId; }
  get transactionId(): string { return this.state.transactionId; }
  get direction(): LedgerDirection { return this.state.direction; }
  get money(): Money { return this.state.money; }
  get balanceBefore(): Money { return this.state.balanceBefore; }
  get balanceAfter(): Money { return this.state.balanceAfter; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  isBalanced(): boolean {
    const expected = this.direction === 'CREDIT'
      ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
