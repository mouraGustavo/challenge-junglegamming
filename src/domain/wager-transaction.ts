import { DomainError, type FailureCode } from './errors';
import { Money } from './money';
import type { LedgerDirection } from './ledger-entry';

export type WagerKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export interface WagerState {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  payloadHash: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerKind; money: Money; referenceExternalTransactionId?: string;
  createdAt: Date; status: WagerStatus; referenceTransactionId?: string;
  failureCode?: FailureCode; processedAt?: Date;
}
export type CreateWagerProps = Omit<WagerState, 'status' | 'failureCode' | 'processedAt' | 'referenceTransactionId'>;

export class WagerTransaction {
  private constructor(private readonly state: WagerState) {}
  static create(props: CreateWagerProps): WagerTransaction {
    if ((props.kind === 'REFUND' || props.kind === 'ROLLBACK') && !props.referenceExternalTransactionId) {
      throw new DomainError('INVALID_REFERENCE');
    }
    if (props.money.isNegative() || (props.kind !== 'LOSS' && !props.money.isPositive())) throw new DomainError('INVALID_AMOUNT');
    return WagerTransaction.rehydrate({ ...props, status: 'PENDING' });
  }
  static rehydrate(state: WagerState): WagerTransaction {
    return new WagerTransaction({ ...state, createdAt: new Date(state.createdAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined });
  }
  get id(): string { return this.state.id; }
  get providerId(): string { return this.state.providerId; }
  get externalTransactionId(): string { return this.state.externalTransactionId; }
  get walletId(): string { return this.state.walletId; }
  get playerId(): string { return this.state.playerId; }
  get roundId(): string { return this.state.roundId; }
  get kind(): WagerKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get referenceExternalTransactionId(): string | undefined { return this.state.referenceExternalTransactionId; }
  get status(): WagerStatus { return this.state.status; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get processedAt(): Date | undefined { return this.state.processedAt ? new Date(this.state.processedAt) : undefined; }
  isTerminal(): boolean { return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status); }
  affectsBalance(): boolean { return this.kind !== 'LOSS'; }
  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK' || Boolean(this.referenceExternalTransactionId);
  }
  matchesPayload(hash: string): boolean { return this.state.payloadHash === hash; }
  assertMatchingPayload(hash: string): void {
    if (!this.matchesPayload(hash)) throw new DomainError('IDEMPOTENCY_CONFLICT');
  }
  validateReference(reference: WagerTransaction): void {
    if (reference.status !== 'PROCESSED') throw new DomainError('REFERENCE_NOT_PROCESSED');
    if (reference.providerId !== this.providerId || reference.walletId !== this.walletId
      || reference.playerId !== this.playerId || reference.roundId !== this.roundId
      || reference.money.currency !== this.money.currency
      || reference.externalTransactionId !== this.referenceExternalTransactionId) throw new DomainError('INVALID_REFERENCE');
    const allowed = this.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
    if (!allowed.includes(reference.kind)) throw new DomainError('INVALID_REFERENCE');
    if ((this.kind === 'REFUND' || this.kind === 'ROLLBACK') && !this.money.equals(reference.money)) {
      throw new DomainError('INVALID_REFERENCE');
    }
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === 'LOSS') throw new DomainError('INVALID_TRANSACTION_STATE');
    if (this.requiresReference() && !reference) throw new DomainError('INVALID_REFERENCE');
    if (reference) this.validateReference(reference);
    if (this.kind === 'ROLLBACK') {
      if (!reference) throw new DomainError('INVALID_REFERENCE');
      return reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    }
    return this.kind === 'BET' ? 'DEBIT' : 'CREDIT';
  }
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if (this.requiresReference() && !referenceTransactionId) throw new DomainError('INVALID_REFERENCE');
    this.state.status = 'PROCESSED';
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = new Date(at);
  }
  markPendingReference(): void {
    this.assertMutable();
    if (!this.requiresReference()) throw new DomainError('INVALID_REFERENCE');
    this.state.status = 'PENDING_REFERENCE';
  }
  reject(code: FailureCode): void { this.finish('REJECTED', code); }
  fail(code: FailureCode): void { this.finish('FAILED', code); }
  private finish(status: 'REJECTED' | 'FAILED', code: FailureCode): void {
    this.assertMutable(); this.state.status = status; this.state.failureCode = code;
  }
  private assertMutable(): void { if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE'); }
}
