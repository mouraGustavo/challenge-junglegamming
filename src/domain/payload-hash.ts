import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from './money';
import type { WagerKind } from './wager-transaction';

export interface WagerPayload {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: Exclude<WagerKind, 'OPENING'>;
  money: MoneyProps; referenceExternalTransactionId?: string;
}
/** Subconjunto explícito, objetos com chaves ordenadas, SHA-256 UTF-8. */
export function payloadHash(input: WagerPayload): string {
  const business = {
    providerId: input.providerId, externalTransactionId: input.externalTransactionId,
    playerId: input.playerId, walletId: input.walletId, roundId: input.roundId,
    gameId: input.gameId, kind: input.kind, money: Money.from(input.money).toJSON(),
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
  };
  function canonical(value: unknown): string {
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }
  return createHash('sha256').update(canonical(business), 'utf8').digest('hex');
}
