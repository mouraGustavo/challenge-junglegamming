import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { wagerInput, walletInput, uuid } from '../../src/application/contracts';
import { ApplicationError } from '../../src/application/errors';
import { DomainError } from '../../src/domain/errors';
import { WagerTransactionProcessed } from '../../src/domain/events';

const input = () => ({ providerId: 'p', externalTransactionId: 'e', playerId: randomUUID(), walletId: randomUUID(),
  roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25.0', currency: 'BRL' } });

test('contratos: tipos, identidade, referência, moeda e OPENING são validados', () => {
  for (const value of [null, [], 'invalid', { ...input(), kind: 'OPENING' },
    { ...input(), playerId: 'invalid' }, { ...input(), kind: 'REFUND' },
    { ...input(), referenceExternalTransactionId: 'bet' },
    { ...input(), providerId: '  p' }, { ...input(), money: { amount: '1', currency: 'USD' } },
    { ...input(), money: { amount: '0.00', currency: 'BRL' } }]) {
    assert.throws(() => wagerInput(value), (error) => error instanceof ApplicationError || error instanceof DomainError);
  }
  assert.equal(wagerInput(input()).money.amount, '25.00');
  assert.equal(wagerInput({ ...input(), kind: 'LOSS', money: { amount: '0', currency: 'BRL' } }).money.amount, '0.00');
  const id = randomUUID();
  assert.equal(uuid(id.toUpperCase()), id);
  assert.throws(() => walletInput({ playerId: id, initialBalance: { amount: '-1', currency: 'BRL' } }));
});

test('eventos: envelope versionado preserva cópia de data e payload', () => {
  const data = { transactionId: 't', walletId: 'w', providerId: 'p', externalTransactionId: 'e', status: 'PROCESSED' as const };
  const at = new Date('2026-10-21T12:00:00Z');
  const event = WagerTransactionProcessed.from(data, { eventId: 'event', correlationId: 'correlation', occurredAt: at });
  data.providerId = 'mutated';
  at.setUTCFullYear(2000);
  event.occurredAt.setUTCFullYear(2001);
  const json = event.toJSON();
  json.data.providerId = 'also-mutated';
  assert.equal(event.toJSON().data.providerId, 'p');
  assert.equal(event.toJSON().occurredAt, '2026-10-21T12:00:00.000Z');
  assert.equal(event.toJSON().eventType, 'WagerTransactionProcessed');
  assert.equal(event.toJSON().version, 1);
});
