import { ApplicationError } from './errors';
import { Money, type MoneyProps } from '../domain/money';
import type { WagerPayload } from '../domain/payload-hash';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationError('INVALID_PAYLOAD', 400);
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
    throw new ApplicationError('INVALID_TEXT', 400);
  }
  return value;
}

export function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) {
    throw new ApplicationError('INVALID_UUID', 400);
  }
  // PostgreSQL normaliza UUIDs; o hash precisa usar a mesma representação.
  return result.toLowerCase();
}

function money(value: unknown): MoneyProps {
  const input = object(value);
  const normalized = Money.from({ amount: input.amount as string, currency: input.currency as string });
  if (normalized.currency !== 'BRL') throw new ApplicationError('UNSUPPORTED_CURRENCY', 400);
  return normalized.toJSON();
}

export function walletInput(value: unknown): { playerId: string; initialBalance: MoneyProps } {
  const input = object(value);
  return { playerId: uuid(input.playerId), initialBalance: money(input.initialBalance) };
}

export function wagerInput(value: unknown): WagerPayload {
  const input = object(value);
  const kind = text(input.kind);
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind)) {
    throw new ApplicationError('INVALID_KIND', 400);
  }
  const reference = input.referenceExternalTransactionId === undefined
    ? undefined : text(input.referenceExternalTransactionId);
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && !reference) {
    throw new ApplicationError('REFERENCE_REQUIRED', 400);
  }
  // BET não depende de outra operação; referências opcionais são de WIN/LOSS.
  if (kind === 'BET' && reference) throw new ApplicationError('UNEXPECTED_REFERENCE', 400);
  const amount = money(input.money);
  if (kind !== 'LOSS' && Money.from(amount).isZero()) throw new ApplicationError('INVALID_AMOUNT', 400);
  return {
    providerId: text(input.providerId), externalTransactionId: text(input.externalTransactionId),
    playerId: uuid(input.playerId), walletId: uuid(input.walletId),
    roundId: text(input.roundId), gameId: text(input.gameId),
    kind: kind as WagerPayload['kind'], money: amount,
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}
