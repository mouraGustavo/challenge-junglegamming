import { createHash, randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError, databaseCode } from './errors';
import { text, uuid, wagerInput, walletInput } from './contracts';
import { DomainError, type FailureCode } from '../domain/errors';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { payloadHash } from '../domain/payload-hash';
import { WagerTransaction, type WagerKind, type WagerStatus } from '../domain/wager-transaction';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import { IntegrationEvent, WalletBalanceChanged, WagerTransactionProcessed,
  WagerTransactionRejected, WagerTransactionPendingReference } from '../domain/events';
import { InboxRecord, LedgerRecord, OutboxRecord, WagerRecord, WalletRecord } from '../persistence/records';

export interface ProcessingContext {
  correlationId?: string;
  causationId?: string;
  inbox?: { consumerName: string; messageId: string };
}
export interface WagerResult {
  transactionId: string;
  status: WagerStatus;
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

/** Um único limite transacional para HTTP e, no próximo bloco, SQS. */
export class FinancialService {
  constructor(private readonly database: () => Promise<MikroORM>) {}

  async createWallet(input: unknown, context: ProcessingContext = {}) {
    context = { ...context, correlationId: context.correlationId ?? randomUUID() };
    const props = walletInput(input);
    const wallet = Wallet.open({ id: randomUUID(), playerId: props.playerId,
      initialBalance: Money.from(props.initialBalance) });
    const orm = await this.database();
    try {
      await orm.em.fork().transactional(async (em) => {
        em.persist(WalletRecord.fromDomain(wallet));
        await em.flush();
        const entry = wallet.openingEntry({ entryId: randomUUID(), transactionId: randomUUID() });
        if (entry) {
          const transaction = WagerTransaction.create({ id: entry.transactionId,
            providerId: '__internal__', externalTransactionId: entry.transactionId,
            idempotencyKey: `opening:${wallet.id}`, payloadHash: '0'.repeat(64),
            walletId: wallet.id, playerId: wallet.playerId, roundId: 'opening', gameId: 'internal',
            kind: 'OPENING', money: wallet.balance, createdAt: wallet.createdAt });
          transaction.markProcessed(undefined, wallet.createdAt);
          const result = this.result(transaction, wallet);
          em.persist(this.record(transaction, { providerId: '__internal__', gameId: 'internal',
            idempotencyKey: `opening:${wallet.id}`, payloadHash: '0'.repeat(64), createdAt: wallet.createdAt }, result));
          await em.flush();
          em.persist(this.ledgerRecord(entry));
          this.enqueue(em, WalletBalanceChanged.from(wallet, entry, this.eventContext(context)));
          this.enqueueStatus(em, transaction, context);
        }
        // Ordem explícita: as FKs são verificadas imediatamente pelo PostgreSQL.
        await em.flush();
      });
    } catch (error) {
      if (databaseCode(error) === '23505') throw new ApplicationError('WALLET_ALREADY_EXISTS', 409);
      throw error;
    }
    return this.walletView(wallet);
  }

  async process(input: unknown, key: unknown, context: ProcessingContext = {}): Promise<WagerResult> {
    context = { ...context, correlationId: context.correlationId ?? randomUUID() };
    const payload = wagerInput(input);
    if (key === undefined) throw new ApplicationError('IDEMPOTENCY_KEY_REQUIRED', 400);
    const idempotencyKey = text(key, 400);
    const hash = payloadHash(payload);
    const inboxHash = createHash('sha256').update(JSON.stringify({ hash, idempotencyKey })).digest('hex');
    const orm = await this.database();
    // UNIQUE pode competir entre wallets diferentes. Após rollback, ler novamente
    // numa transação nova permite classificar replay/conflito sem estado abortado.
    for (let attempt = 0; ; attempt++) {
      try {
        return await orm.em.fork().transactional(async (em) => {
          await em.getConnection().execute("set local lock_timeout = '3s'", [], 'run', em.getTransactionContext());
          const identity = await em.findOne(WagerRecord, { idempotencyKey });
          if (identity && identity.payloadHash !== hash) throw new ApplicationError('IDEMPOTENCY_CONFLICT', 409);
          const stored = await em.findOne(WalletRecord, payload.walletId, { lockMode: LockMode.PESSIMISTIC_WRITE });
          if (!stored) throw new ApplicationError('WALLET_NOT_FOUND', 404);
          const wallet = stored.toDomain();
          // Identificação incompatível é contrato inválido, antes da aceitação.
          if (wallet.playerId !== payload.playerId) throw new ApplicationError('WALLET_PLAYER_MISMATCH', 400);
          if (wallet.currency !== payload.money.currency) throw new ApplicationError('CURRENCY_MISMATCH', 400);

          let inbox: InboxRecord | undefined;
          if (context.inbox) {
            const identity = { consumerName: text(context.inbox.consumerName), messageId: text(context.inbox.messageId) };
            inbox = await em.findOne(InboxRecord, identity) ?? undefined;
            if (inbox) {
              if (inbox.payloadHash !== inboxHash) throw new ApplicationError('INBOX_PAYLOAD_CONFLICT', 409);
              if (inbox.processedAt && inbox.result) return this.replay(inbox.result);
            } else {
              inbox = Object.assign(new InboxRecord(), identity, { payloadHash: inboxHash, receivedAt: new Date() });
              em.persist(inbox);
            }
          }

          const existing = await em.findOne(WagerRecord, { idempotencyKey });
          if (existing) {
            if (existing.payloadHash !== hash) throw new ApplicationError('IDEMPOTENCY_CONFLICT', 409);
            if (!existing.result) throw new Error('MISSING_PERSISTED_RESULT');
            const replay = this.replay(existing.result);
            this.finishInbox(inbox, replay);
            return replay;
          }
          if (await em.findOne(WagerRecord, { providerId: payload.providerId,
            externalTransactionId: payload.externalTransactionId })) {
            throw new ApplicationError('EXTERNAL_TRANSACTION_CONFLICT', 409);
          }

          const at = new Date();
          const transaction = WagerTransaction.create({ ...payload, id: randomUUID(), idempotencyKey,
            payloadHash: hash, money: Money.from(payload.money), createdAt: at });
          let reference: WagerTransaction | undefined;
          let entry: WalletLedgerEntry | undefined;
          try {
            if (transaction.requiresReference()) {
              const found = await em.findOne(WagerRecord, { providerId: payload.providerId,
                externalTransactionId: payload.referenceExternalTransactionId! });
              if (!found) {
                transaction.markPendingReference();
              } else {
                reference = this.toDomain(found);
                // Referência ainda não terminal aguarda processamento, sem perder a operação.
                if (!reference.isTerminal()) transaction.markPendingReference();
                else transaction.validateReference(reference);
              }
            }
            if (transaction.status !== 'PENDING_REFERENCE') {
              if (reference && (transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK')) {
                const reversal = await em.findOne(WagerRecord, { referenceTransactionId: reference.id,
                  kind: transaction.kind, status: 'PROCESSED' });
                if (reversal) throw new DomainError('REVERSAL_ALREADY_PROCESSED');
              }
              if (transaction.affectsBalance()) {
                const movement = { entryId: randomUUID(), transactionId: transaction.id,
                  money: transaction.money, at };
                entry = transaction.ledgerDirectionFor(reference) === 'DEBIT'
                  ? wallet.debit(movement, transaction.kind === 'ROLLBACK') : wallet.credit(movement);
              }
              transaction.markProcessed(reference?.id, at);
            }
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            transaction.reject(error.code);
          }

          const result = this.result(transaction, wallet);
          const record = this.record(transaction, { ...payload, idempotencyKey, payloadHash: hash, createdAt: at }, result);
          if (transaction.status === 'PENDING_REFERENCE') {
            record.referenceAttempts = 0;
            record.nextAttemptAt = new Date(at.getTime() + 1000);
          }
          em.persist(record);
          await em.flush();
          if (entry) {
            em.assign(stored, { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt });
            em.persist(this.ledgerRecord(entry));
            this.enqueue(em, WalletBalanceChanged.from(wallet, entry, this.eventContext(context)));
          }
          this.enqueueStatus(em, transaction, context);
          this.finishInbox(inbox, result);
          await em.flush();
          return result;
        });
      } catch (error) {
        if (attempt >= 2 || !['23505', '40001', '40P01'].includes(databaseCode(error) ?? '')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }

  async getWallet(id: unknown) {
    const orm = await this.database();
    const record = await orm.em.fork().findOne(WalletRecord, uuid(id));
    if (!record) throw new ApplicationError('WALLET_NOT_FOUND', 404);
    return this.walletView(record.toDomain());
  }

  async getTransaction(id: unknown) {
    const orm = await this.database();
    const record = await orm.em.fork().findOne(WagerRecord, uuid(id));
    if (!record) throw new ApplicationError('TRANSACTION_NOT_FOUND', 404);
    return this.transactionView(record);
  }

  async getProviderTransaction(providerId: unknown, externalTransactionId: unknown) {
    const orm = await this.database();
    const record = await orm.em.fork().findOne(WagerRecord, {
      providerId: text(providerId), externalTransactionId: text(externalTransactionId),
    });
    if (!record) throw new ApplicationError('TRANSACTION_NOT_FOUND', 404);
    return this.transactionView(record);
  }

  async ledger(id: unknown, cursor?: unknown, inputLimit?: unknown) {
    const walletId = uuid(id);
    const limitText = inputLimit === undefined ? '50' : text(inputLimit, 3);
    if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 100) {
      throw new ApplicationError('INVALID_LIMIT', 400);
    }
    const limit = Number(limitText); // Contagem, nunca dinheiro.
    const orm = await this.database();
    const em = orm.em.fork();
    if (!await em.findOne(WalletRecord, walletId)) throw new ApplicationError('WALLET_NOT_FOUND', 404);
    let afterId: string | undefined;
    if (cursor !== undefined) {
      try {
        const encoded = text(cursor, 300);
        if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid');
        const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (decoded.walletId !== walletId) throw new Error('invalid');
        afterId = uuid(decoded.id);
        if (!await em.findOne(LedgerRecord, { id: afterId, walletId })) throw new Error('invalid');
      } catch { throw new ApplicationError('INVALID_CURSOR', 400); }
    }
    // A comparação usa o timestamp original do banco, preservando microssegundos.
    const rows = await em.getConnection().execute<{ id: string }[]>(`
      select id from wallet_ledger_entries where wallet_id = ?
      ${afterId ? 'and (created_at, id) > (select created_at, id from wallet_ledger_entries where id = ?)' : ''}
      order by created_at, id limit ?`, afterId ? [walletId, afterId, limit + 1] : [walletId, limit + 1]);
    const pageIds = rows.slice(0, limit).map((row) => row.id);
    const records = pageIds.length ? await em.find(LedgerRecord, { id: { $in: pageIds } }) : [];
    const byId = new Map(records.map((record) => [record.id, record]));
    const entries = pageIds.map((entryId) => {
      const record = byId.get(entryId)!;
      return { id: record.id, walletId, transactionId: record.transactionId, direction: record.direction,
        money: Money.rehydrate({ amount: record.amount, currency: record.currency }).toJSON(),
        balanceBefore: Money.rehydrate({ amount: record.balanceBefore, currency: record.currency }).toJSON(),
        balanceAfter: Money.rehydrate({ amount: record.balanceAfter, currency: record.currency }).toJSON(),
        createdAt: record.createdAt.toISOString() };
    });
    return { entries, nextCursor: rows.length > limit
      ? Buffer.from(JSON.stringify({ walletId, id: pageIds.at(-1) })).toString('base64url') : null };
  }

  async reconcile(id: unknown) {
    const walletId = uuid(id);
    const orm = await this.database();
    return orm.em.fork().transactional(async (em) => {
      const record = await em.findOne(WalletRecord, walletId, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!record) throw new ApplicationError('WALLET_NOT_FOUND', 404);
      const [row] = await em.getConnection().execute<{ calculated: string; total: string }[]>(`
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::text as calculated,
        count(*)::text as total from wallet_ledger_entries where wallet_id = ?`,
      [walletId], 'all', em.getTransactionContext());
      const stored = record.toDomain().balance;
      const calculated = Money.rehydrate({ amount: row.calculated, currency: record.currency });
      return { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(),
        difference: stored.subtract(calculated).toJSON(), consistent: stored.equals(calculated), checkedEntries: Number(row.total) };
    });
  }

  private walletView(wallet: Wallet) {
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
  private transactionView(record: WagerRecord) {
    return { transactionId: record.id, providerId: record.providerId, externalTransactionId: record.externalTransactionId,
      walletId: record.walletId, playerId: record.playerId, roundId: record.roundId, gameId: record.gameId,
      kind: record.kind, money: Money.rehydrate({ amount: record.amount, currency: record.currency }).toJSON(),
      status: record.status, referenceExternalTransactionId: record.referenceExternalTransactionId ?? null,
      referenceTransactionId: record.referenceTransactionId ?? null, failureCode: record.failureCode ?? null,
      createdAt: record.createdAt.toISOString(), processedAt: record.processedAt?.toISOString() ?? null,
      result: record.result };
  }
  private result(transaction: WagerTransaction, wallet: Wallet): WagerResult {
    return { transactionId: transaction.id, status: transaction.status, balance: wallet.balance.toJSON(),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}), idempotentReplay: false };
  }
  private replay(result: Record<string, unknown>): WagerResult {
    return { ...structuredClone(result), idempotentReplay: true } as unknown as WagerResult;
  }
  private finishInbox(inbox: InboxRecord | undefined, result: WagerResult): void {
    if (inbox) { inbox.result = { ...result }; inbox.processedAt = new Date(); }
  }
  private record(transaction: WagerTransaction, props: {
    providerId: string; gameId: string; idempotencyKey: string; payloadHash: string; createdAt: Date;
  }, result: WagerResult): WagerRecord {
    return Object.assign(new WagerRecord(), { ...props, id: transaction.id,
      externalTransactionId: transaction.externalTransactionId, walletId: transaction.walletId,
      playerId: transaction.playerId, roundId: transaction.roundId, kind: transaction.kind,
      amount: transaction.money.toString(), currency: transaction.money.currency, status: transaction.status,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId, failureCode: transaction.failureCode,
      processedAt: transaction.processedAt, result: { ...result }, referenceAttempts: 0 });
  }
  private toDomain(record: WagerRecord): WagerTransaction {
    return WagerTransaction.rehydrate({ ...record, kind: record.kind as WagerKind,
      status: record.status as WagerStatus, failureCode: record.failureCode as FailureCode | undefined,
      money: Money.rehydrate({ amount: record.amount, currency: record.currency }) });
  }
  private ledgerRecord(entry: WalletLedgerEntry): LedgerRecord {
    return Object.assign(new LedgerRecord(), { id: entry.id, walletId: entry.walletId,
      transactionId: entry.transactionId, direction: entry.direction, amount: entry.money.toString(),
      currency: entry.money.currency, balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(), createdAt: entry.createdAt });
  }
  private eventContext(context: ProcessingContext) {
    return { eventId: randomUUID(), correlationId: context.correlationId ?? randomUUID(),
      causationId: context.causationId, occurredAt: new Date() };
  }
  private enqueue(em: EntityManager, event: IntegrationEvent<object>): void {
    em.persist(Object.assign(new OutboxRecord(), { id: event.eventId, aggregateId: event.aggregateId,
      eventType: event.eventType, payload: { ...event.toJSON() }, occurredAt: event.occurredAt,
      attempts: 0, nextAttemptAt: event.occurredAt }));
  }
  private enqueueStatus(em: EntityManager, transaction: WagerTransaction, context: ProcessingContext): void {
    const data = { transactionId: transaction.id, walletId: transaction.walletId,
      providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
      status: transaction.status, ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}) };
    const ctx = this.eventContext(context);
    if (transaction.status === 'PROCESSED') this.enqueue(em, WagerTransactionProcessed.from(data, ctx));
    else if (transaction.status === 'REJECTED') this.enqueue(em, WagerTransactionRejected.from(data, ctx));
    else this.enqueue(em, WagerTransactionPendingReference.from(data, ctx));
  }
}
