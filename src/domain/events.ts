import type { MoneyProps } from './money';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry, LedgerDirection } from './ledger-entry';
import type { WagerStatus } from './wager-transaction';

export interface EventContext {
  eventId: string; correlationId: string; causationId?: string; occurredAt: Date;
}
interface IntegrationEventProps<T> extends EventContext { aggregateId: string; data: T }

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  private readonly timestamp: string;
  private readonly snapshot: T;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.timestamp = props.occurredAt.toISOString();
    this.snapshot = structuredClone(props.data);
  }
  get occurredAt(): Date { return new Date(this.timestamp); }
  get data(): Readonly<T> { return structuredClone(this.snapshot); }
  toJSON() {
    return { eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId,
      correlationId: this.correlationId, ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.timestamp, version: this.version, data: structuredClone(this.snapshot) };
  }
}

export interface WagerEventData {
  transactionId: string; walletId: string; providerId: string; externalTransactionId: string;
  status: WagerStatus; failureCode?: string;
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(data: WagerEventData, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: data.walletId, data });
  }
}
export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(data: WagerEventData, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({ ...ctx, aggregateId: data.walletId, data });
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(data: WagerEventData, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: data.walletId, data });
  }
}

export class WagerTransactionFailed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
  static from(data: WagerEventData, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed({ ...ctx, aggregateId: data.walletId, data });
  }
}

interface WalletBalanceChangedData {
  walletId: string; transactionId: string; direction: LedgerDirection; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id, data: {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    } });
  }
}
