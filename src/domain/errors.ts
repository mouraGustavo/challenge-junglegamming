export type FailureCode =
  | 'INVALID_MONEY' | 'CURRENCY_MISMATCH' | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_FUNDS' | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'INVALID_TRANSACTION_STATE' | 'INVALID_REFERENCE'
  | 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_PROCESSED'
  | 'REVERSAL_ALREADY_PROCESSED' | 'IDEMPOTENCY_CONFLICT';

export class DomainError extends Error {
  constructor(public readonly code: FailureCode, message: string = code) {
    super(message);
    this.name = 'DomainError';
  }
}
