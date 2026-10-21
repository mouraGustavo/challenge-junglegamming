import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config';
import { createOrm } from '../../src/persistence/orm';
import { migrate } from '../../src/persistence/migrate';
import { WalletRecord } from '../../src/persistence/records';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

/** Usa PostgreSQL real. Cada execução cria e remove seu próprio banco descartável. */
test('PostgreSQL: migrations, constraints, ORM, imutabilidade e rollback atômico', async () => {
  const dbName = `wagering_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await createOrm();
  let orm: Awaited<ReturnType<typeof createOrm>> | undefined;
  let created = false;
  try {
    // Identificador gerado internamente: apenas prefixo fixo e UUID hexadecimal.
    await admin.em.getConnection().execute(`create database "${dbName}"`);
    created = true;
    orm = await createOrm(true, { ...config.database, dbName });
    const sql = (query: string, params: unknown[] = []) => orm!.em.getConnection().execute(query, params);
    const fail = async (query: string, params: unknown[], code: string) => {
      await assert.rejects(() => sql(query, params), (error: unknown) => {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
      });
    };
    assert.deepEqual(await migrate(orm, 'up'), ['001-financial-schema']);
    assert.deepEqual(await migrate(orm, 'up'), ['001-financial-schema']);
    assert.deepEqual(await migrate(orm, 'down'), []);
    assert.deepEqual(await migrate(orm, 'up'), ['001-financial-schema']);
    const walletId = randomUUID(), playerId = randomUUID(), openingId = randomUUID(), ledgerId = randomUUID();
    await sql(`insert into wallets(id,player_id,currency,balance) values (?,?,'BRL',100.00)`, [walletId, playerId]);
    await fail(`insert into wallets(id,player_id,currency,balance) values (?,?,'BRL',0)`, [randomUUID(), playerId], '23505');
    await fail(`update wallets set balance = -0.01 where id = ?`, [walletId], '23514');
    await fail(`update wallets set balance = 1.001 where id = ?`, [walletId], '23514');
    await fail(`update wallets set balance = 'NaN'::numeric where id = ?`, [walletId], '23514');
    await fail(`update wallets set version = 0 where id = ?`, [walletId], '23514');
    const insertWager = `insert into wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,
       round_id,game_id,kind,amount,currency,status,processed_at)
      values (?,'internal',?,?,?, ?,?,'opening','internal','OPENING',100.00,'BRL','PROCESSED',now())`;
    await sql(insertWager, [openingId, openingId, openingId, 'a'.repeat(64), walletId, playerId]);
    // As duas identidades são únicas de forma independente.
    await fail(insertWager.replace("'OPENING'", "'BET'"), [randomUUID(), openingId, randomUUID(), 'a'.repeat(64), walletId, playerId], '23505');
    await fail(insertWager.replace("'OPENING'", "'BET'"), [randomUUID(), randomUUID(), openingId, 'a'.repeat(64), walletId, playerId], '23505');
    await fail(insertWager, [randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), walletId, playerId], '23505');
    const insertLedger = `insert into wallet_ledger_entries
      (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
      values (?,?,?,'CREDIT',100.00,'BRL',0.00,100.00)`;
    await sql(insertLedger, [ledgerId, walletId, openingId]);
    await fail(insertLedger, [randomUUID(), walletId, openingId], '23505');
    await fail(insertLedger.replace('0.00,100.00', '0.00,99.00'), [randomUUID(), walletId, openingId], '23514');
    await fail('update wallet_ledger_entries set amount = amount where id = ?', [ledgerId], '23514');
    await fail('delete from wallet_ledger_entries where id = ?', [ledgerId], '23514');
    await fail('truncate wallet_ledger_entries', [], '23514');
    // Um lançamento precisa pertencer à mesma wallet/moeda da transação.
    await fail(insertLedger, [randomUUID(), randomUUID(), openingId], '23503');
    await sql(`insert into inbox_messages(consumer_name,message_id,payload_hash) values ('wager','m1',?)`, ['a'.repeat(64)]);
    await fail(`insert into inbox_messages(consumer_name,message_id,payload_hash) values ('wager','m1',?)`, ['a'.repeat(64)], '23505');

    const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(),
      initialBalance: Money.from({ amount: '9007199254740993.01', currency: 'BRL' }) });
    const em = orm.em.fork();
    await em.persistAndFlush(WalletRecord.fromDomain(wallet));
    em.clear();
    const record = await em.findOneOrFail(WalletRecord, wallet.id);
    assert.equal(typeof record.balance, 'string');
    assert.equal(record.toDomain().balance.toString(), '9007199254740993.01');
    // Sem criar dados financeiros incompletos permanentes no teste de mapeamento.
    await sql('delete from wallets where id = ?', [wallet.id]);

    // Reversões rejeitadas continuam auditáveis; somente PROCESSED ocupa o índice.
    const referenceId = randomUUID();
    await sql(`insert into wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,
       round_id,game_id,kind,amount,currency,status,processed_at)
      values (?,'p',?,?,?, ?,?,'round','game','BET',25.00,'BRL','PROCESSED',now())`,
      [referenceId, referenceId, referenceId, 'b'.repeat(64), walletId, playerId]);
    await sql(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
      values (?,?,?,'DEBIT',25.00,'BRL',100.00,75.00)`, [randomUUID(), walletId, referenceId]);
    await sql('update wallets set balance = 75.00, version = 2 where id = ?', [walletId]);
    const reversal = `insert into wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,
       round_id,game_id,kind,amount,currency,status,processed_at,reference_external_transaction_id,reference_transaction_id)
      values (?,'p',?,?,?, ?,?,'round','game','REFUND',25.00,'BRL','PROCESSED',now(),?,?)`;
    const refundId = randomUUID();
    await sql(reversal, [refundId, refundId, refundId, 'c'.repeat(64), walletId, playerId, referenceId, referenceId]);
    await fail(reversal, [randomUUID(), randomUUID(), randomUUID(), 'c'.repeat(64), walletId, playerId, referenceId, referenceId], '23505');
    await sql(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
      values (?,?,?,'CREDIT',25.00,'BRL',75.00,100.00)`, [randomUUID(), walletId, refundId]);
    await sql('update wallets set balance = 100.00, version = 3 where id = ?', [walletId]);

    const rolledWallet = randomUUID(), rolledTransaction = randomUUID(), rolledEvent = randomUUID();
    await assert.rejects(() => orm!.em.fork().transactional(async (tx) => {
      const execute = (query: string, params: unknown[] = []) =>
        tx.getConnection().execute(query, params, 'all', tx.getTransactionContext());
      const player = randomUUID();
      await execute(`insert into wallets(id,player_id,currency,balance) values (?,?,'BRL',100.00)`, [rolledWallet, player]);
      await execute(insertWager, [rolledTransaction, rolledTransaction, rolledTransaction, 'd'.repeat(64), rolledWallet, player]);
      await execute(insertLedger, [randomUUID(), rolledWallet, rolledTransaction]);
      await execute(`insert into inbox_messages(consumer_name,message_id,payload_hash) values ('wager','rollback-test',?)`, ['d'.repeat(64)]);
      await execute(`insert into outbox_messages(id,aggregate_id,event_type,payload) values (?,?,'WalletBalanceChanged','{}')`, [rolledEvent, rolledWallet]);
      throw new Error('INJECTED_FAILURE');
    }), /INJECTED_FAILURE/);
    for (const [table, column, id] of [['wallets', 'id', rolledWallet], ['wager_transactions', 'id', rolledTransaction],
      ['wallet_ledger_entries', 'wallet_id', rolledWallet], ['inbox_messages', 'message_id', 'rollback-test'],
      ['outbox_messages', 'id', rolledEvent]]) {
      const rows = await sql(`select count(*)::text as total from ${table} where ${column} = ?`, [id]) as { total: string }[];
      assert.equal(rows[0].total, '0', `rollback: ${table}`);
    }
    const reconciliation = await sql(`select w.balance::text as stored,
      coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end),0)::text as calculated
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`, [walletId]) as { stored: string; calculated: string }[];
    assert.ok(Money.from({ amount: reconciliation[0].stored, currency: 'BRL' })
      .equals(Money.from({ amount: reconciliation[0].calculated, currency: 'BRL' })));
    console.log(JSON.stringify({ event: 'schema-tests', result: 'ok', database: dbName }));
  } finally {
    await orm?.close(true);
    try {
      if (created) await admin.em.getConnection().execute(`drop database "${dbName}" with (force)`);
    } finally { await admin.close(true); }
  }
});
