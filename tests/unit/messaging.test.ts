import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InboxMessage } from '../../src/domain/inbox-message';
import { OutboxMessage, retryDelay } from '../../src/domain/outbox-message';
import { WagerTransactionProcessed } from '../../src/domain/events';
import { parseRequest } from '../../src/messaging/envelope';

test('Inbox: factories, cópias de datas e conclusão única', () => {
  const at = new Date('2026-10-22T12:00:00Z');
  const message = InboxMessage.receive({ consumerName: 'wager', messageId: 'm', payloadHash: 'h', receivedAt: at });
  at.setUTCFullYear(2000);
  message.receivedAt.setUTCFullYear(2001);
  assert.equal(message.receivedAt.getUTCFullYear(), 2026);
  assert.equal(message.isProcessed(), false);
  message.markProcessed(new Date());
  assert.equal(message.isProcessed(), true);
  assert.throws(() => message.markProcessed(new Date()), /INBOX_ALREADY_PROCESSED/);
  assert.equal(InboxMessage.rehydrate({ consumerName: 'c', messageId: 'm', payloadHash: 'h',
    receivedAt: at, processedAt: at }).isProcessed(), true);
});

test('Outbox: backoff limitado, payload encapsulado e estado publicado terminal', () => {
  const at = new Date('2026-10-22T12:00:00Z');
  const event = WagerTransactionProcessed.from({ transactionId: 't', walletId: 'w', providerId: 'p',
    externalTransactionId: 'e', status: 'PROCESSED' }, { eventId: 'id', correlationId: 'c', occurredAt: at });
  const message = OutboxMessage.enqueue(event);
  assert.equal(message.isDue(at), true);
  message.scheduleRetry(at);
  assert.equal(message.attempts, 1);
  assert.equal(message.nextAttemptAt.getTime() - at.getTime(), 1000);
  assert.equal(message.isDue(at), false);
  message.scheduleRetry(at);
  assert.equal(message.nextAttemptAt.getTime() - at.getTime(), 2000);
  assert.equal(retryDelay(100), 60000);
  const payload = message.payload;
  (payload.data as Record<string, unknown>).providerId = 'mutated';
  assert.equal((message.payload.data as Record<string, unknown>).providerId, 'p');
  message.markPublished(at);
  assert.equal(message.isPending(), false);
  assert.throws(() => message.scheduleRetry(at), /OUTBOX_ALREADY_PUBLISHED/);
});

test('SQS: envelope e contrato de domínio são validados sem aceitar OPENING', () => {
  const data = { providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'p:e',
    playerId: randomUUID(), walletId: randomUUID(), roundId: 'r', gameId: 'g', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' } };
  const envelope = { messageId: 'm', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
  const parsed = parseRequest(JSON.stringify(envelope));
  assert.equal(parsed.idempotencyKey, 'p:e');
  assert.equal(parsed.payload.money.amount, '25.00');
  assert.equal(parsed.correlationId, 'm');
  for (const invalid of [undefined, 'bad-json', JSON.stringify({ ...envelope, occurredAt: 'invalid' }),
    JSON.stringify({ ...envelope, type: 'WalletBalanceChanged' }),
    JSON.stringify({ ...envelope, data: { ...data, kind: 'OPENING' } }),
    JSON.stringify({ ...envelope, data: { ...data, idempotencyKey: undefined } })]) {
    assert.throws(() => parseRequest(invalid));
  }
});
