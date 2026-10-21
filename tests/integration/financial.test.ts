import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { WalletRecord } from '../../src/persistence/records';
import { FinancialService } from '../../src/application/financial-service';
import { ApplicationError } from '../../src/application/errors';
import { Money } from '../../src/domain/money';
import { temporaryDatabase } from './database';

test('Financeiro: transações reais, replay, concorrência, referências e atomicidade', async () => {
  const db = await temporaryDatabase();
  const service = new FinancialService(async () => db.orm);
  const sql = <T extends object[]>(query: string, params: unknown[] = []) => db.orm.em.getConnection().execute<T>(query, params);
  async function check(name: string, run: () => Promise<void>) {
    console.log(JSON.stringify({ event: 'financial-scenario', scenario: name, status: 'running' }));
    await run();
    console.log(JSON.stringify({ event: 'financial-scenario', scenario: name, status: 'passed' }));
  }
  const wallets: string[] = [];
  const money = (amount: string) => ({ amount, currency: 'BRL' });
  async function open(amount = '100.00') {
    const wallet = await service.createWallet({ playerId: randomUUID(), initialBalance: money(amount) });
    wallets.push(wallet.id);
    return wallet;
  }
  function payload(wallet: { id: string; playerId: string }, kind = 'BET', amount = '25.00', reference?: string) {
    return { providerId: 'provider-a', externalTransactionId: randomUUID(), playerId: wallet.playerId,
      walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', kind, money: money(amount),
      ...(reference ? { referenceExternalTransactionId: reference } : {}) };
  }
  const key = (value: { externalTransactionId: string }) => `provider-a:${value.externalTransactionId}`;
  const rejects = (code: string) => (error: unknown) => error instanceof ApplicationError && error.code === code;
  try {
    await check('abertura, unicidade, zero e precisão acima de MAX_SAFE_INTEGER', async () => {
      const wallet = await open('9007199254740993.01');
      assert.equal(wallet.version, 1);
      const ledger = await service.ledger(wallet.id);
      assert.equal(ledger.entries.length, 1);
      assert.equal(ledger.entries[0].money.amount, '9007199254740993.01');
      assert.equal(ledger.entries[0].balanceBefore.amount, '0.00');
      await assert.rejects(() => service.createWallet({ playerId: wallet.playerId, initialBalance: money('0.00') }),
        rejects('WALLET_ALREADY_EXISTS'));
      const zero = await open('0.00');
      assert.equal((await service.ledger(zero.id)).entries.length, 0);
    });

    await check('50 apostas idênticas paralelas causam um débito e dois eventos', async () => {
      const wallet = await open();
      const bet = payload(wallet);
      // Esperar todas antes de fechar o banco, inclusive se alguma falhar.
      const outcomes = await Promise.allSettled(Array.from({ length: 50 }, () => service.process(bet, key(bet))));
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
      assert.deepEqual(failures.map((outcome) => outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)), []);
      const results = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : []);
      assert.equal(results.filter((result) => !result.idempotentReplay).length, 1);
      assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
      assert.ok(results.every((result) => result.balance.amount === '75.00'));
      assert.equal((await service.getWallet(wallet.id)).balance.amount, '75.00');
      const ledger = await service.ledger(wallet.id);
      assert.equal(ledger.entries.filter((entry) => entry.direction === 'DEBIT').length, 1);
      const [{ total }] = await sql<{ total: string }[]>(
        `select count(*)::text as total from outbox_messages where payload->'data'->>'transactionId' = ?`,
        [results[0].transactionId]);
      assert.equal(total, '2');
    });

    await check('duas BET de 80 contra 100: um sucesso, uma rejeição, saldo 20', async () => {
      const wallet = await open();
      const bets = [payload(wallet, 'BET', '80.00'), payload(wallet, 'BET', '80.00')];
      const results = await Promise.all(bets.map((bet) => service.process(bet, key(bet))));
      assert.equal(results.filter((result) => result.status === 'PROCESSED').length, 1);
      assert.equal(results.find((result) => result.status === 'REJECTED')?.failureCode, 'INSUFFICIENT_FUNDS');
      assert.equal((await service.getWallet(wallet.id)).balance.amount, '20.00');
      assert.equal((await service.getWallet(wallet.id)).version, 2);
      assert.equal((await service.ledger(wallet.id)).entries.length, 2);
      const repeated = await service.process(bets[0], key(bets[0]));
      assert.deepEqual(repeated, { ...results[0], idempotentReplay: true });
    });

    await check('replay preserva saldo antigo; chave divergente e identidade externa conflitam', async () => {
      const wallet = await open();
      const bet = payload(wallet);
      const first = await service.process(bet, key(bet));
      const win = payload(wallet, 'WIN', '10.00');
      await service.process(win, key(win));
      assert.equal((await service.getWallet(wallet.id)).balance.amount, '85.00');
      assert.deepEqual(await service.process(bet, key(bet)), { ...first, idempotentReplay: true });
      await assert.rejects(() => service.process({ ...bet, money: money('26.00') }, key(bet)), rejects('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(() => service.process({ ...bet, walletId: randomUUID() }, key(bet)), rejects('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(() => service.process(bet, `${key(bet)}-other`), rejects('EXTERNAL_TRANSACTION_CONFLICT'));
      assert.equal((await service.getProviderTransaction(bet.providerId, bet.externalTransactionId)).transactionId, first.transactionId);
    });

    await check('disputa de chave e identidade externa entre wallets distintas', async () => {
      const first = payload(await open());
      const second = payload(await open());
      const sharedKey = randomUUID();
      const results = await Promise.allSettled([service.process(first, sharedKey), service.process(second, sharedKey)]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected' && rejects('IDEMPOTENCY_CONFLICT')(rejected.reason));
      const third = payload(await open());
      const fourth = { ...payload(await open()), externalTransactionId: third.externalTransactionId };
      const external = await Promise.allSettled([service.process(third, randomUUID()), service.process(fourth, randomUUID())]);
      assert.equal(external.filter((result) => result.status === 'fulfilled').length, 1);
      const conflict = external.find((result) => result.status === 'rejected');
      assert.ok(conflict?.status === 'rejected' && rejects('EXTERNAL_TRANSACTION_CONFLICT')(conflict.reason));
    });

    await check('WIN, LOSS, REFUND, ROLLBACK e reversão repetida auditável', async () => {
      const wallet = await open();
      const bet = payload(wallet);
      await service.process(bet, key(bet));
      const loss = payload(wallet, 'LOSS', '0.00');
      assert.equal((await service.process(loss, key(loss))).status, 'PROCESSED');
      assert.equal((await service.getWallet(wallet.id)).version, 2);
      const refund = payload(wallet, 'REFUND', '25.00', bet.externalTransactionId);
      assert.equal((await service.process(refund, key(refund))).balance.amount, '100.00');
      const again = payload(wallet, 'REFUND', '25.00', bet.externalTransactionId);
      assert.equal((await service.process(again, key(again))).failureCode, 'REVERSAL_ALREADY_PROCESSED');
      const rollback = payload(wallet, 'ROLLBACK', '25.00', refund.externalTransactionId);
      assert.equal((await service.process(rollback, key(rollback))).balance.amount, '75.00');
      assert.equal((await service.getWallet(wallet.id)).version, 4);
      assert.equal((await service.ledger(wallet.id)).entries.length, 4);
    });

    await check('reversão sem saldo tem failureCode próprio e não gera ledger', async () => {
      const wallet = await open('0.00');
      const win = payload(wallet, 'WIN', '25.00');
      await service.process(win, key(win));
      const bet = payload(wallet);
      await service.process(bet, key(bet));
      const rollback = payload(wallet, 'ROLLBACK', '25.00', win.externalTransactionId);
      const result = await service.process(rollback, key(rollback));
      assert.equal(result.status, 'REJECTED');
      assert.equal(result.failureCode, 'REVERSAL_INSUFFICIENT_FUNDS');
      assert.equal((await service.ledger(wallet.id)).entries.length, 2);
    });

    await check('referências inválidas são rejeitadas; ausentes são persistidas pendentes', async () => {
      const wallet = await open();
      const bet = payload(wallet);
      await service.process(bet, key(bet));
      const invalid = { ...payload(wallet, 'REFUND', '25.00', bet.externalTransactionId), roundId: 'another-round' };
      assert.equal((await service.process(invalid, key(invalid))).failureCode, 'INVALID_REFERENCE');
      const pending = payload(wallet, 'ROLLBACK', '25.00', randomUUID());
      const result = await service.process(pending, key(pending));
      assert.equal(result.status, 'PENDING_REFERENCE');
      assert.equal((await service.getWallet(wallet.id)).balance.amount, '75.00');
      assert.equal((await service.getTransaction(result.transactionId)).status, 'PENDING_REFERENCE');
      assert.deepEqual(await service.process(pending, key(pending)), { ...result, idempotentReplay: true });
    });

    await check('inbox é atômica e redelivery não duplica; conteúdo divergente conflita', async () => {
      const wallet = await open();
      const bet = payload(wallet);
      const context = { inbox: { consumerName: 'wager', messageId: randomUUID() } };
      const first = await service.process(bet, key(bet), context);
      assert.deepEqual(await service.process(bet, key(bet), context), { ...first, idempotentReplay: true });
      await assert.rejects(() => service.process({ ...bet, externalTransactionId: randomUUID() }, randomUUID(), context),
        rejects('INBOX_PAYLOAD_CONFLICT'));
      const [{ total }] = await sql<{ total: string }[]>('select count(*)::text as total from inbox_messages where message_id = ?',
        [context.inbox.messageId]);
      assert.equal(total, '1');
    });

    await check('falha na outbox reverte wallet, ledger, wager e inbox; retry funciona', async () => {
      const wallet = await open();
      const bet = payload(wallet);
      const context = { inbox: { consumerName: 'wager', messageId: randomUUID() } };
      await sql(`create function fail_test_outbox() returns trigger language plpgsql as $$
        begin raise exception 'INJECTED_OUTBOX_FAILURE'; end; $$`);
      await sql('create trigger fail_test_outbox before insert on outbox_messages for each row execute function fail_test_outbox()');
      try { await assert.rejects(() => service.process(bet, key(bet), context), /INJECTED_OUTBOX_FAILURE/); }
      finally {
        await sql('drop trigger fail_test_outbox on outbox_messages');
        await sql('drop function fail_test_outbox()');
      }
      assert.equal((await service.getWallet(wallet.id)).balance.amount, '100.00');
      assert.equal((await service.ledger(wallet.id)).entries.length, 1);
      const [wager] = await sql<{ total: string }[]>('select count(*)::text as total from wager_transactions where idempotency_key = ?', [key(bet)]);
      const [inbox] = await sql<{ total: string }[]>('select count(*)::text as total from inbox_messages where message_id = ?', [context.inbox.messageId]);
      assert.equal(wager.total, '0');
      assert.equal(inbox.total, '0');
      assert.equal((await service.process(bet, key(bet), context)).balance.amount, '75.00');
    });

    await check('paginação opaca sem entradas repetidas e limites validados', async () => {
      const wallet = await open();
      for (let index = 0; index < 5; index++) {
        const bet = payload(wallet, 'BET', '1.00');
        await service.process(bet, key(bet));
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.ledger(wallet.id, cursor, '2');
        seen.push(...page.entries.map((entry) => entry.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(seen.length, 6);
      assert.equal(new Set(seen).size, 6);
      await assert.rejects(() => service.ledger(wallet.id, 'garbage'), rejects('INVALID_CURSOR'));
      await assert.rejects(() => service.ledger(wallet.id, undefined, '101'), rejects('INVALID_LIMIT'));
      const other = await open();
      const page = await service.ledger(wallet.id, undefined, '2');
      await assert.rejects(() => service.ledger(other.id, page.nextCursor!), rejects('INVALID_CURSOR'));
    });

    await check('wallet bloqueada não impede o processamento de outra wallet', async () => {
      const lockedWallet = await open();
      const freeWallet = await open();
      let unlock!: () => void;
      let announce!: () => void;
      const gate = new Promise<void>((resolve) => { unlock = resolve; });
      const acquired = new Promise<void>((resolve) => { announce = resolve; });
      const holder = db.orm.em.fork().transactional(async (em) => {
        await em.findOneOrFail(WalletRecord, lockedWallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
        announce();
        await gate;
      });
      // Se o holder falhar antes de anunciar, propagar erro em vez de esperar indefinidamente.
      await Promise.race([acquired, holder]);
      try {
        const bet = payload(freeWallet);
        assert.equal((await service.process(bet, key(bet))).balance.amount, '75.00');
      } finally { unlock(); await holder; }
    });

    await check('todas as wallets reconciliam; diferença é sinalizada sem correção', async () => {
      for (const walletId of wallets) {
        const reconciliation = await service.reconcile(walletId);
        assert.equal(reconciliation.consistent, true, walletId);
        assert.equal(reconciliation.difference.amount, '0.00');
      }
      const wallet = await open();
      await sql('update wallets set balance = 99.00 where id = ?', [wallet.id]);
      const result = await service.reconcile(wallet.id);
      assert.equal(result.consistent, false);
      assert.ok(Money.rehydrate(result.difference).equals(Money.from(money('1.00')).negate()));
      assert.equal((await service.getWallet(wallet.id)).balance.amount, '99.00');
      await sql('update wallets set balance = 100.00 where id = ?', [wallet.id]);
    });
  } finally { await db.close(); }
});
