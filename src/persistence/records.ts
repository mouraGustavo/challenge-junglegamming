import { EntitySchema, DecimalType } from '@mikro-orm/core';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';

/** Registros do ORM são DTOs de persistência; regras ficam nas classes de domínio. */
export class WalletRecord {
  id!: string; playerId!: string; currency!: string; balance!: string;
  version!: number; createdAt!: Date; updatedAt!: Date;
  static fromDomain(wallet: Wallet): WalletRecord {
    return Object.assign(new WalletRecord(), {
      id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.toString(), version: wallet.version,
      createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
    });
  }
  toDomain(): Wallet {
    return Wallet.rehydrate({ id: this.id, playerId: this.playerId,
      balance: Money.rehydrate({ amount: this.balance, currency: this.currency }),
      version: this.version, createdAt: this.createdAt, updatedAt: this.updatedAt });
  }
}
export class WagerRecord {
  id!: string; providerId!: string; externalTransactionId!: string; idempotencyKey!: string;
  payloadHash!: string; walletId!: string; playerId!: string; roundId!: string; gameId!: string;
  kind!: string; amount!: string; currency!: string; status!: string;
  referenceExternalTransactionId?: string; referenceTransactionId?: string;
  failureCode?: string; processedAt?: Date; createdAt!: Date;
  result?: Record<string, unknown>; referenceAttempts!: number; nextAttemptAt?: Date;
}
export class LedgerRecord {
  id!: string; walletId!: string; transactionId!: string; direction!: string;
  amount!: string; currency!: string; balanceBefore!: string; balanceAfter!: string; createdAt!: Date;
}
export class InboxRecord {
  consumerName!: string; messageId!: string; payloadHash!: string;
  receivedAt!: Date; processedAt?: Date; result?: Record<string, unknown>;
}
export class OutboxRecord {
  id!: string; aggregateId!: string; eventType!: string; payload!: Record<string, unknown>;
  occurredAt!: Date; attempts!: number; nextAttemptAt!: Date; publishedAt?: Date;
}
const uuid = { type: 'uuid' } as const;
const text = { type: 'text' } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;
const amount = { type: new DecimalType('string'), columnType: 'numeric' };

export const WalletSchema = new EntitySchema<WalletRecord>({ class: WalletRecord, tableName: 'wallets', properties: {
  id: { ...uuid, primary: true }, playerId: uuid, currency: text, balance: amount,
  version: { type: 'integer' }, createdAt: timestamp, updatedAt: timestamp,
} });
export const WagerSchema = new EntitySchema<WagerRecord>({ class: WagerRecord, tableName: 'wager_transactions', properties: {
  id: { ...uuid, primary: true }, providerId: text, externalTransactionId: text, idempotencyKey: text,
  payloadHash: text, walletId: uuid, playerId: uuid, roundId: text, gameId: text, kind: text,
  amount, currency: text, status: text, referenceExternalTransactionId: { ...text, nullable: true },
  referenceTransactionId: { ...uuid, nullable: true }, failureCode: { ...text, nullable: true },
  processedAt: { ...timestamp, nullable: true }, createdAt: timestamp,
  result: { type: 'json', nullable: true }, referenceAttempts: { type: 'integer', default: 0 },
  nextAttemptAt: { ...timestamp, nullable: true },
} });
export const LedgerSchema = new EntitySchema<LedgerRecord>({ class: LedgerRecord, tableName: 'wallet_ledger_entries', properties: {
  id: { ...uuid, primary: true }, walletId: uuid, transactionId: uuid, direction: text, amount, currency: text,
  balanceBefore: amount, balanceAfter: amount, createdAt: timestamp,
} });
export const InboxSchema = new EntitySchema<InboxRecord>({ class: InboxRecord, tableName: 'inbox_messages', properties: {
  consumerName: { ...text, primary: true }, messageId: { ...text, primary: true }, payloadHash: text,
  receivedAt: timestamp, processedAt: { ...timestamp, nullable: true }, result: { type: 'json', nullable: true },
} });
export const OutboxSchema = new EntitySchema<OutboxRecord>({ class: OutboxRecord, tableName: 'outbox_messages', properties: {
  id: { ...uuid, primary: true }, aggregateId: uuid, eventType: text, payload: { type: 'json' },
  occurredAt: timestamp, attempts: { type: 'integer', default: 0 }, nextAttemptAt: timestamp,
  publishedAt: { ...timestamp, nullable: true },
} });
export const entities = [WalletSchema, WagerSchema, LedgerSchema, InboxSchema, OutboxSchema];
