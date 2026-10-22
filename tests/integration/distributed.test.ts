import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { config } from '../../src/config';
import { createQueues, type QueueUrls } from '../../src/messaging/queues';
import { temporaryDatabase } from './database';
import type { WagerResult } from '../../src/application/financial-service';

const execute = promisify(execFile);
async function docker(...args: string[]) {
  const result = await execute('docker', args, { windowsHide: true, timeout: 95000, maxBuffer: 1024 * 1024 * 5 });
  return result.stdout.trim();
}
async function until(check: () => Promise<boolean>, label: string, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`TIMEOUT: ${label}`);
}

test('Docker: três instâncias, kill real após commit/envio, SIGTERM e reinício consistente', async () => {
  const network = process.env.TEST_DOCKER_NETWORK ?? 'challenge-junglegamming_default';
  const image = process.env.TEST_DOCKER_IMAGE ?? 'challenge-junglegamming:local';
  await docker('image', 'inspect', image);
  await docker('network', 'inspect', network);
  const db = await temporaryDatabase();
  const sqs = new SQSClient(config.sqs);
  const suffix = randomUUID();
  const prefix = `jungle-test-${suffix}`;
  const names = { input: `test-${suffix}-input.fifo`, dlq: `test-${suffix}-dlq.fifo`, events: `test-${suffix}-events.fifo` };
  let urls: QueueUrls | undefined;
  const containers: string[] = [];
  const wallets: string[] = [];
  const sql = <T extends object[]>(query: string, params: unknown[] = []) => db.orm.em.getConnection().execute<T>(query, params);
  const money = (amount: string) => ({ amount, currency: 'BRL' });
  async function start(role: 'api' | 'worker' | 'consumer' | 'publisher', index: number): Promise<{ name: string; url: string }> {
    const name = `${prefix}-${role}-${index}`;
    assert.ok(name.startsWith(`${prefix}-`));
    containers.push(name);
    const command = role === 'api' ? ['bun', 'dist/src/main.js'] : role === 'worker'
      ? ['bun', 'dist/src/worker.js'] : ['bun', 'dist/tests/fixtures/crash-worker.js', role];
    const port = role === 'api' ? '3000' : '9100';
    await docker('run', '-d', '--name', name, '--network', network,
      '-p', `127.0.0.1::${port}`, '-e', 'HOST=0.0.0.0', '-e', 'DB_HOST=postgres', '-e', 'DB_PORT=5432',
      '-e', `DB_NAME=${db.dbName}`, '-e', 'SQS_ENDPOINT=http://localstack:4566',
      '-e', `SQS_INPUT_QUEUE=${names.input}`, '-e', `SQS_DLQ_QUEUE=${names.dlq}`, '-e', `SQS_EVENTS_QUEUE=${names.events}`,
      image, ...command);
    const published = await docker('port', name, `${port}/tcp`);
    const url = `http://${published.split('\n')[0]}`;
    if (role === 'api' || role === 'worker') {
      await until(async () => { try { return (await fetch(`${url}/health/ready`)).ok; } catch { return false; } }, `ready ${name}`);
    }
    return { name, url };
  }
  async function http<T>(base: string, path: string, body?: unknown, key?: string) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  async function open(base: string, amount = '100.00') {
    const result = await http<{ id: string; playerId: string }>(base, '/wallets', { playerId: randomUUID(), initialBalance: money(amount) });
    assert.equal(result.status, 201);
    wallets.push(result.body.id);
    return result.body;
  }
  function wager(wallet: { id: string; playerId: string }, kind = 'BET', amount = '25.00') {
    const externalTransactionId = randomUUID();
    return { providerId: 'distributed', externalTransactionId, idempotencyKey: `distributed:${externalTransactionId}`,
      walletId: wallet.id, playerId: wallet.playerId, roundId: 'r', gameId: 'g', kind, money: money(amount) };
  }
  async function send(data: ReturnType<typeof wager>) {
    const messageId = randomUUID();
    await sqs.send(new SendMessageCommand({ QueueUrl: urls!.input, MessageGroupId: data.walletId,
      MessageDeduplicationId: randomUUID(), MessageBody: JSON.stringify({ messageId,
        type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }) }));
    return messageId;
  }
  async function check(scenario: string, run: () => Promise<void>) {
    console.log(JSON.stringify({ event: 'distributed-scenario', scenario, status: 'running' }));
    await run();
    console.log(JSON.stringify({ event: 'distributed-scenario', scenario, status: 'passed' }));
  }
  async function waitLogs(name: string, event: string) {
    await until(async () => (await docker('logs', name)).includes(event), event);
  }
  async function drainEvents() {
    const ids: string[] = [];
    for (let iteration = 0; iteration < 100; iteration++) {
      const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: urls!.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
      if (!received.Messages?.length) break;
      for (const message of received.Messages) {
        ids.push((JSON.parse(message.Body!) as { eventId: string }).eventId);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: urls!.events, ReceiptHandle: message.ReceiptHandle! }));
      }
    }
    return ids;
  }
  try {
    urls = await createQueues(sqs, names);
    const apis = await Promise.all([start('api', 1), start('api', 2), start('api', 3)]);
    const base = apis[0].url;
    let original: { wallet: { id: string; playerId: string }; transactionId: string };
    await check('50 apostas idênticas distribuídas entre três processos: um débito', async () => {
      const wallet = await open(base);
      const payload = wager(wallet);
      const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
        http<WagerResult>(apis[index % 3].url, '/wagering/transactions', payload, payload.idempotencyKey)));
      assert.ok(results.every((result) => result.status === 200));
      assert.equal(results.filter((result) => !result.body.idempotentReplay).length, 1);
      assert.equal(new Set(results.map((result) => result.body.transactionId)).size, 1);
      assert.equal((await http<{ balance: { amount: string } }>(base, `/wallets/${wallet.id}`)).body.balance.amount, '75.00');
      const [{ total }] = await sql<{ total: string }[]>(`select count(*)::text as total from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.id]);
      assert.equal(total, '1');
      original = { wallet, transactionId: results[0].body.transactionId };
      const metrics = await Promise.all(apis.map(async (api) => (await fetch(`${api.url}/metrics`)).text()));
      const duplicates = metrics.reduce((sum, value) => sum + Number(value.match(/^wagering_duplicates_total (\d+)$/m)![1]), 0);
      assert.equal(duplicates, 49);
    });
    await check('apostas disputam saldo e wallets distintas progridem em processos distintos', async () => {
      const wallet = await open(base);
      const bets = [wager(wallet, 'BET', '80.00'), wager(wallet, 'BET', '80.00')];
      const results = await Promise.all(bets.map((bet, index) => http<WagerResult>(apis[index].url,
        '/wagering/transactions', bet, bet.idempotencyKey)));
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 422]);
      assert.equal((await http<{ balance: { amount: string } }>(base, `/wallets/${wallet.id}`)).body.balance.amount, '20.00');
      const distinct = await Promise.all(apis.map((api) => open(api.url)));
      const outcomes = await Promise.all(distinct.map((value, index) => {
        const bet = wager(value);
        return http<WagerResult>(apis[index].url, '/wagering/transactions', bet, bet.idempotencyKey);
      }));
      assert.ok(outcomes.every((result) => result.status === 200));
    });
    await check('SIGKILL depois do commit e antes do ack: outro processo recupera sem duplicar', async () => {
      const wallet = await open(base);
      const payload = wager(wallet);
      const messageId = await send(payload);
      const dying = await start('consumer', 1);
      await waitLogs(dying.name, 'test_after_commit_before_ack');
      const [{ total }] = await sql<{ total: string }[]>('select count(*)::text as total from inbox_messages where message_id = ? and processed_at is not null', [messageId]);
      assert.equal(total, '1');
      await docker('kill', '--signal', 'SIGKILL', dying.name);
      assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', dying.name), '137');
      const recovery = await start('worker', 1);
      await waitLogs(recovery.name, '"idempotentReplay":true');
      const metrics = await (await fetch(`${recovery.url}/metrics`)).text();
      assert.match(metrics, /wagering_duplicates_total [1-9]/);
      assert.equal((await http<{ balance: { amount: string } }>(base, `/wallets/${wallet.id}`)).body.balance.amount, '75.00');
      const [{ count }] = await sql<{ count: string }[]>('select count(*)::text as count from wallet_ledger_entries where wallet_id = ?', [wallet.id]);
      assert.equal(count, '2');
      await until(async () => (await sql<{ total: string }[]>('select count(*)::text as total from outbox_messages where published_at is null'))[0].total === '0', 'outbox antes da parada');
      await docker('stop', '--time', '60', recovery.name);
      assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', recovery.name), '0');
    });
    await check('SIGKILL depois de enviar evento: publishers novos recuperam outbox', async () => {
      await until(async () => (await sql<{ total: string }[]>('select count(*)::text as total from outbox_messages where published_at is null'))[0].total === '0', 'outbox anterior');
      await drainEvents();
      const wallet = await open(base);
      const dying = await start('publisher', 1);
      await waitLogs(dying.name, 'test_after_send_before_mark');
      await docker('kill', '--signal', 'SIGKILL', dying.name);
      const [pending] = await sql<{ total: string }[]>('select count(*)::text as total from outbox_messages where aggregate_id = ? and published_at is null', [wallet.id]);
      assert.equal(pending.total, '2');
      const workers = await Promise.all([start('worker', 2), start('worker', 3), start('worker', 4)]);
      await until(async () => (await sql<{ total: string }[]>('select count(*)::text as total from outbox_messages where published_at is null'))[0].total === '0', 'publishers recuperarem outbox');
      const ids = await drainEvents();
      const rows = await sql<{ id: string }[]>('select id from outbox_messages where aggregate_id = ?', [wallet.id]);
      assert.deepEqual(new Set(ids), new Set(rows.map((row) => row.id)));
      await Promise.all(workers.map((worker) => docker('stop', '--time', '60', worker.name)));
    });
    await check('SIGTERM durante mensagem em andamento espera commit e ack', async () => {
      const wallet = await open(base);
      const payload = wager(wallet);
      let unlock!: () => void;
      let announce!: () => void;
      const gate = new Promise<void>((resolve) => { unlock = resolve; });
      const acquired = new Promise<void>((resolve) => { announce = resolve; });
      const holder = db.orm.em.fork().transactional(async (em) => {
        await em.getConnection().execute('select id from wallets where id = ? for update', [wallet.id], 'all', em.getTransactionContext());
        announce(); await gate;
      });
      await Promise.race([acquired, holder]);
      const worker = await start('worker', 5);
      const messageId = await send(payload);
      let stopping: Promise<string> | undefined;
      try {
        await until(async () => (await sql<{ total: string }[]>(
          `select count(*)::text as total from pg_stat_activity where datname = ? and wait_event_type = 'Lock'`, [db.dbName]))[0].total !== '0', 'mensagem em andamento', 2500);
        stopping = docker('stop', '--time', '60', worker.name);
        // Esperar que o sinal chegue antes de liberar o lock, sem esperar o stop terminar.
        await waitLogs(worker.name, 'workers_stopping');
      } finally { unlock(); await holder; }
      await stopping;
      assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', worker.name), '0');
      assert.ok((await docker('logs', worker.name)).includes('workers_drained'));
      const [inbox] = await sql<{ total: string }[]>('select count(*)::text as total from inbox_messages where message_id = ? and processed_at is not null', [messageId]);
      assert.equal(inbox.total, '1');
      assert.equal((await http<{ balance: { amount: string } }>(base, `/wallets/${wallet.id}`)).body.balance.amount, '75.00');
    });
    await check('reiniciar API preserva resultado original, saldo e ledger', async () => {
      await docker('restart', '--time', '15', apis[0].name);
      // Portas efêmeras de containers de teste podem mudar ao reiniciar.
      const binding = await docker('port', apis[0].name, '3000/tcp');
      const restartedBase = `http://${binding.split('\n')[0]}`;
      await until(async () => { try { return (await fetch(`${restartedBase}/health/ready`)).ok; } catch { return false; } }, 'API reiniciada');
      const result = await http<{ status: string; result: WagerResult }>(restartedBase, `/wagering/transactions/${original!.transactionId}`);
      assert.equal(result.body.status, 'PROCESSED');
      assert.equal(result.body.result.balance.amount, '75.00');
      for (const walletId of wallets) {
        const reconciliation = await http<{ consistent: boolean }>(restartedBase, `/wallets/${walletId}/reconciliation`, {});
        assert.equal(reconciliation.status, 200);
        assert.equal(reconciliation.body.consistent, true, walletId);
      }
    });
  } finally {
    // Apenas recursos nomeados por UUID desta execução; nunca down -v/prune global.
    const removed = await Promise.allSettled(containers.map((name) => docker('rm', '-f', name)));
    removed.forEach((result) => { if (result.status === 'rejected') console.error('Test container cleanup failed'); });
    try { if (urls) for (const url of Object.values(urls)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url })); }
    finally { sqs.destroy(); await db.close(); }
  }
});
