import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../../src/app';
import { config } from '../../src/config';
import type { WagerResult } from '../../src/application/financial-service';
import { temporaryDatabase } from './database';

test('HTTP real: contratos, códigos, consultas, health e replay', async () => {
  const db = await temporaryDatabase();
  const originalName = config.database.dbName;
  config.database.dbName = db.dbName;
  const app = await createApplication(true);
  try {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    async function request<T = Record<string, unknown>>(path: string, body?: unknown, key?: string) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as T };
    }
    const created = await request<{ id: string; playerId: string; balance: { amount: string }; version: number }>('/wallets', {
      playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.balance.amount, '100.00');
    assert.equal(created.body.version, 1);
    const walletId = created.body.id;
    const wager = { providerId: 'provider-http', externalTransactionId: randomUUID(),
      playerId: created.body.playerId, walletId, roundId: 'r', gameId: 'g', kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' } };
    const key = `${wager.providerId}:${wager.externalTransactionId}`;
    assert.equal((await request('/wagering/transactions', wager)).status, 400);
    assert.equal((await request('/wagering/transactions', { ...wager, kind: 'OPENING' }, key)).status, 400);
    assert.equal((await request('/wagering/transactions', { ...wager, money: { amount: 25, currency: 'BRL' } }, key)).status, 400);
    assert.equal((await request('/wagering/transactions', { ...wager, playerId: randomUUID() }, key)).status, 400);
    const processed = await request<WagerResult>('/wagering/transactions', wager, key);
    assert.equal(processed.status, 200);
    assert.equal(processed.body.status, 'PROCESSED');
    assert.equal(processed.body.balance.amount, '75.00');
    const replay = await request<WagerResult>('/wagering/transactions', wager, key);
    assert.deepEqual(replay.body, { ...processed.body, idempotentReplay: true });
    assert.equal(replay.status, 200);
    assert.equal((await request('/wagering/transactions', { ...wager, gameId: 'other' }, key)).status, 409);
    assert.equal((await request(`/wagering/transactions/${processed.body.transactionId}`)).status, 200);
    assert.equal((await request(`/providers/${wager.providerId}/wagering/transactions/${wager.externalTransactionId}`)).status, 200);
    const rejected = await request<WagerResult>('/wagering/transactions', {
      ...wager, externalTransactionId: randomUUID(), money: { amount: '80.00', currency: 'BRL' },
    }, randomUUID());
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.failureCode, 'INSUFFICIENT_FUNDS');
    const pending = await request<WagerResult>('/wagering/transactions', {
      ...wager, externalTransactionId: randomUUID(), kind: 'REFUND', referenceExternalTransactionId: randomUUID(),
    }, randomUUID());
    assert.equal(pending.status, 202);
    assert.equal(pending.body.status, 'PENDING_REFERENCE');
    const ledger = await request<{ entries: unknown[]; nextCursor: string }>(`/wallets/${walletId}/ledger?limit=1`);
    assert.equal(ledger.status, 200);
    assert.equal(ledger.body.entries.length, 1);
    assert.ok(ledger.body.nextCursor);
    assert.equal((await request(`/wallets/${walletId}/ledger?limit=0`)).status, 400);
    assert.equal((await request(`/wallets/${walletId}/ledger?cursor=bad`)).status, 400);
    const reconciliation = await request(`/wallets/${walletId}/reconciliation`, {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.consistent, true);
    assert.equal((await request(`/wallets/${randomUUID()}`)).status, 404);
    assert.equal((await request('/wallets/invalid')).status, 400);
    let unlock!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const acquired = new Promise<void>((resolve) => { announce = resolve; });
    const holder = db.orm.em.fork().transactional(async (em) => {
      await em.getConnection().execute('select id from wallets where id = ? for update',
        [walletId], 'all', em.getTransactionContext());
      announce();
      await gate;
    });
    await Promise.race([acquired, holder]);
    try {
      const unavailable = await request('/wagering/transactions', { ...wager, externalTransactionId: randomUUID() }, randomUUID());
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.code, 'INFRASTRUCTURE_UNAVAILABLE');
    } finally { unlock(); await holder; }
    assert.equal((await request(`/wallets/${walletId}/reconciliation`, {})).body.consistent, true);
    assert.equal((await request('/health/live')).status, 200);
    const ready = await request('/health/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body.checks, { postgres: true, sqs: true });
  } finally {
    await app.close();
    config.database.dbName = originalName;
    await db.close();
  }
});
