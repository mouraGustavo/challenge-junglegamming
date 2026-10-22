import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand,
  DeleteQueueCommand, ChangeMessageVisibilityCommand, type Message } from '@aws-sdk/client-sqs';
import { config } from '../../src/config';
import { FinancialService } from '../../src/application/financial-service';
import { SqsConsumer } from '../../src/messaging/sqs-consumer';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';
import { ReferenceWorker } from '../../src/messaging/reference-worker';
import { createQueues, type QueueUrls } from '../../src/messaging/queues';
import { parseRequest } from '../../src/messaging/envelope';
import { WorkerRuntime } from '../../src/messaging/worker-runtime';
import { telemetry } from '../../src/observability/telemetry';
import { temporaryDatabase } from './database';

test('SQS/PostgreSQL reais: inbox, outbox, retry, DLQ, referências e shutdown', async () => {
  const db = await temporaryDatabase();
  const sqs = new SQSClient(config.sqs);
  const suffix = randomUUID();
  const names = { input: `test-${suffix}-input.fifo`, dlq: `test-${suffix}-dlq.fifo`, events: `test-${suffix}-events.fifo` };
  let urls: QueueUrls | undefined;
  const financial = new FinancialService(async () => db.orm);
  const sql = <T extends object[]>(query: string, params: unknown[] = []) => db.orm.em.getConnection().execute<T>(query, params);
  const wallets: string[] = [];
  const money = (amount: string) => ({ amount, currency: 'BRL' });
  async function open(amount = '100.00') {
    const wallet = await financial.createWallet({ playerId: randomUUID(), initialBalance: money(amount) });
    wallets.push(wallet.id);
    return wallet;
  }
  function request(wallet: { id: string; playerId: string }, kind = 'BET', amount = '25.00', reference?: string) {
    const externalTransactionId = randomUUID();
    return { messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: {
      providerId: 'provider-sqs', externalTransactionId, idempotencyKey: `provider-sqs:${externalTransactionId}`,
      playerId: wallet.playerId, walletId: wallet.id, roundId: 'r', gameId: 'g', kind, money: money(amount),
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    } };
  }
  async function send(envelope: ReturnType<typeof request>) {
    await sqs.send(new SendMessageCommand({ QueueUrl: urls!.input, MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId, MessageDeduplicationId: randomUUID() }));
  }
  async function drain(url: string): Promise<Message[]> {
    const result: Message[] = [];
    for (let index = 0; index < 100; index++) {
      const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0, MessageAttributeNames: ['All'] }));
      if (!response.Messages?.length) break;
      for (const message of response.Messages) {
        result.push(message);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
      }
    }
    return result;
  }
  async function check(scenario: string, run: () => Promise<void>) {
    console.log(JSON.stringify({ event: 'messaging-scenario', scenario, status: 'running' }));
    await run();
    console.log(JSON.stringify({ event: 'messaging-scenario', scenario, status: 'passed' }));
  }
  try {
    urls = await createQueues(sqs, names, 5);
    const consumer = () => new SqsConsumer(financial, sqs, urls!, { waitSeconds: 0, retryBaseSeconds: 0, maxAttempts: 2 });

    await check('redelivery com deduplicação FIFO burlada é segura pela inbox e pelo domínio', async () => {
      const wallet = await open();
      const envelope = request(wallet);
      await send(envelope);
      assert.equal(await consumer().consumeOnce(), 'processed');
      await send(envelope); // Mesmo messageId, outro MessageDeduplicationId de transporte.
      assert.equal(await consumer().consumeOnce(), 'processed');
      await send({ ...envelope, messageId: randomUUID() });
      assert.equal(await consumer().consumeOnce(), 'processed');
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '75.00');
      assert.equal((await financial.ledger(wallet.id)).entries.length, 2);
      const [{ total }] = await sql<{ total: string }[]>('select count(*)::text as total from inbox_messages');
      assert.equal(total, '2');
      await send({ ...envelope, data: { ...envelope.data, money: money('26.00') } });
      assert.equal(await consumer().consumeOnce(), 'dlq');
      assert.equal((await drain(urls!.dlq)).length, 1);
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '75.00');
    });

    await check('rejeição de negócio confirma inbox e ack, sem DLQ nem ledger', async () => {
      const wallet = await open('10.00');
      const envelope = request(wallet);
      await send(envelope);
      assert.equal(await consumer().consumeOnce(), 'processed');
      const result = await financial.getProviderTransaction(envelope.data.providerId, envelope.data.externalTransactionId);
      assert.equal(result.status, 'REJECTED');
      assert.equal(result.failureCode, 'INSUFFICIENT_FUNDS');
      assert.equal((await financial.ledger(wallet.id)).entries.length, 1);
      assert.equal((await drain(urls!.dlq)).length, 0);
      assert.equal(await consumer().consumeOnce(), 'idle');
    });

    await check('commit antes de ack: reentrega recupera resultado sem duplicar o débito', async () => {
      const wallet = await open();
      const envelope = request(wallet);
      await send(envelope);
      const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: urls!.input, WaitTimeSeconds: 0 }));
      const message = received.Messages![0];
      const parsed = parseRequest(message.Body);
      await financial.process(parsed.payload, parsed.idempotencyKey, {
        inbox: { consumerName: 'wager-transactions', messageId: parsed.messageId },
      });
      // Simula a janela de crash: commit real, sem delete, e nova entrega pelo broker.
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: urls!.input,
        ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: 0 }));
      assert.equal(await consumer().consumeOnce(), 'processed');
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '75.00');
      assert.equal((await financial.ledger(wallet.id)).entries.length, 2);
    });

    await check('REFUND e ROLLBACK antes da referência são retomados por workers concorrentes', async () => {
      const wallet = await open();
      const bet = request(wallet);
      const refund = request(wallet, 'REFUND', '25.00', bet.data.externalTransactionId);
      await send(refund);
      assert.equal(await consumer().consumeOnce(), 'processed');
      const pending = await financial.getProviderTransaction(refund.data.providerId, refund.data.externalTransactionId);
      assert.equal(pending.status, 'PENDING_REFERENCE');
      await send(bet);
      assert.equal(await consumer().consumeOnce(), 'processed');
      const now = new Date(Date.now() + 5000);
      const workers = [new ReferenceWorker(async () => db.orm, financial), new ReferenceWorker(async () => db.orm, financial)];
      const counts = await Promise.all(workers.map((worker) => worker.runOnce(now)));
      assert.equal(counts[0] + counts[1], 1);
      assert.equal((await financial.getTransaction(pending.transactionId)).status, 'PROCESSED');
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '100.00');
      assert.equal((await financial.ledger(wallet.id)).entries.length, 3);
      const other = await open('0.00');
      const win = request(other, 'WIN');
      const rollback = request(other, 'ROLLBACK', '25.00', win.data.externalTransactionId);
      await send(rollback); await consumer().consumeOnce();
      await send(win); await consumer().consumeOnce();
      const deferred = await financial.getProviderTransaction(rollback.data.providerId, rollback.data.externalTransactionId);
      await financial.retryReference(deferred.transactionId, new Date(Date.now() + 5000));
      assert.equal((await financial.getWallet(other.id)).balance.amount, '0.00');
    });

    await check('referência inexistente: backoff persistente, replay não acelera, limite rejeita', async () => {
      const wallet = await open();
      const envelope = request(wallet, 'REFUND', '25.00', randomUUID());
      await send(envelope); await consumer().consumeOnce();
      const result = await financial.getProviderTransaction(envelope.data.providerId, envelope.data.externalTransactionId);
      const now = new Date(Date.now() + 5000);
      assert.equal(await financial.retryReference(result.transactionId, now, 2), true);
      assert.equal(await financial.retryReference(result.transactionId, now, 2), false);
      await financial.process(envelope.data, envelope.data.idempotencyKey);
      const [state] = await sql<{ reference_attempts: number; next_attempt_at: Date }[]>(
        'select reference_attempts, next_attempt_at from wager_transactions where id = ?', [result.transactionId]);
      assert.equal(state.reference_attempts, 1);
      assert.ok(new Date(state.next_attempt_at).getTime() > now.getTime());
      await financial.retryReference(result.transactionId, new Date(now.getTime() + 10000), 2);
      const rejected = await financial.getTransaction(result.transactionId);
      assert.equal(rejected.status, 'REJECTED');
      assert.equal(rejected.failureCode, 'REFERENCE_NOT_FOUND');
      assert.equal((await financial.ledger(wallet.id)).entries.length, 1);
    });

    await check('erro transitório reverte tudo, nova entrega processa e ack ocorre depois', async () => {
      const wallet = await open();
      const envelope = request(wallet);
      await sql(`create function fail_message_ledger() returns trigger language plpgsql as $$
        begin raise exception 'INJECTED_PROCESS_FAILURE'; end; $$`);
      await sql('create trigger fail_message_ledger before insert on wallet_ledger_entries for each row execute function fail_message_ledger()');
      try {
        await send(envelope);
        assert.equal(await consumer().consumeOnce(), 'retry');
        assert.equal((await financial.getWallet(wallet.id)).balance.amount, '100.00');
        const [{ total }] = await sql<{ total: string }[]>('select count(*)::text as total from inbox_messages where message_id = ?', [envelope.messageId]);
        assert.equal(total, '0');
      } finally {
        await sql('drop trigger fail_message_ledger on wallet_ledger_entries');
        await sql('drop function fail_message_ledger()');
      }
      assert.equal(await consumer().consumeOnce(), 'processed');
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '75.00');
      assert.equal((await drain(urls!.dlq)).length, 0);
    });

    await check('esgotamento de tentativas cria FAILED auditável e preserva comando na DLQ', async () => {
      const wallet = await open();
      const envelope = request(wallet);
      await sql(`create function fail_message_ledger() returns trigger language plpgsql as $$
        begin raise exception 'INJECTED_PROCESS_FAILURE'; end; $$`);
      await sql('create trigger fail_message_ledger before insert on wallet_ledger_entries for each row execute function fail_message_ledger()');
      try {
        await send(envelope);
        assert.equal(await consumer().consumeOnce(), 'retry');
        assert.equal(await consumer().consumeOnce(), 'dlq');
      } finally {
        await sql('drop trigger fail_message_ledger on wallet_ledger_entries');
        await sql('drop function fail_message_ledger()');
      }
      const failed = await financial.getProviderTransaction(envelope.data.providerId, envelope.data.externalTransactionId);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureCode, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '100.00');
      const messages = await drain(urls!.dlq);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].MessageAttributes?.failureCode.StringValue, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
      // FAILED persistido não pode virar ack silencioso numa nova entrega.
      await send(envelope);
      assert.equal(await consumer().consumeOnce(), 'dlq');
      assert.equal((await drain(urls!.dlq)).length, 1);
    });

    await check('mensagem inválida vai diretamente para DLQ', async () => {
      await sqs.send(new SendMessageCommand({ QueueUrl: urls!.input, MessageBody: 'invalid-json',
        MessageGroupId: 'invalid', MessageDeduplicationId: randomUUID() }));
      assert.equal(await consumer().consumeOnce(), 'dlq');
      const messages = await drain(urls!.dlq);
      assert.equal(messages[0].MessageAttributes?.failureCode.StringValue, 'INVALID_MESSAGE_JSON');
    });

    await check('dois publishers publicam outbox concorrente sem perder eventos', async () => {
      const publishers = [new OutboxPublisher(async () => db.orm, sqs, urls!.events), new OutboxPublisher(async () => db.orm, sqs, urls!.events)];
      for (let index = 0; index < 100; index++) {
        const results = await Promise.all(publishers.map((publisher) => publisher.publishOnce(new Date(Date.now() + 20000))));
        if (results.every((result) => result === 'idle')) break;
      }
      const rows = await sql<{ id: string; published_at: Date | null }[]>('select id, published_at from outbox_messages');
      assert.ok(rows.every((row) => row.published_at));
      const messages = await drain(urls!.events);
      const ids = messages.map((message) => (JSON.parse(message.Body!) as { eventId: string }).eventId);
      assert.equal(ids.length, rows.length);
      assert.equal(new Set(ids).size, rows.length);
    });

    await check('falha após envio recupera outbox em novo publisher com eventId estável', async () => {
      const wallet = await open();
      await sql(`create function fail_publish_mark() returns trigger language plpgsql as $$
        begin if NEW.published_at is not null then raise exception 'INJECTED_AFTER_SEND'; end if; return NEW; end; $$`);
      await sql('create trigger fail_publish_mark before update on outbox_messages for each row execute function fail_publish_mark()');
      try {
        const publisher = new OutboxPublisher(async () => db.orm, sqs, urls!.events);
        await assert.rejects(() => publisher.publishOnce(), /INJECTED_AFTER_SEND/);
      } finally {
        await sql('drop trigger fail_publish_mark on outbox_messages');
        await sql('drop function fail_publish_mark()');
      }
      const delivered = await drain(urls!.events);
      assert.equal(delivered.length, 1);
      const eventId = (JSON.parse(delivered[0].Body!) as { eventId: string }).eventId;
      const [pending] = await sql<{ published_at: Date | null }[]>('select published_at from outbox_messages where id = ?', [eventId]);
      assert.equal(pending.published_at, null);
      const recovered = new OutboxPublisher(async () => db.orm, sqs, urls!.events);
      assert.equal(await recovered.publishOnce(), 'published');
      assert.equal(await recovered.publishOnce(), 'published');
      assert.equal(await recovered.publishOnce(), 'idle');
      const extra = await drain(urls!.events);
      // FIFO pode suprimir o segundo envio do mesmo eventId; a linha foi recuperada.
      assert.equal(extra.length, 1);
      assert.equal((await financial.reconcile(wallet.id)).consistent, true);
      // Consumidor externo de demonstração: uma projeção SQL não idempotente
      // fica protegida pela inbox, mesmo burlando a deduplicação FIFO do evento.
      await sql('create table test_event_projection (wallet_id uuid primary key, applied integer not null)');
      for (let index = 0; index < 2; index++) {
        await sqs.send(new SendMessageCommand({ QueueUrl: urls!.events, MessageBody: delivered[0].Body!,
          MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));
      }
      for (let index = 0; index < 2; index++) {
        const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: urls!.events, WaitTimeSeconds: 0 }));
        const duplicate = received.Messages?.[0];
        assert.ok(duplicate);
        const envelope = JSON.parse(duplicate.Body!) as { eventId: string };
        await db.orm.em.fork().transactional(async (em) => {
          const inserted = await em.getConnection().execute<{ message_id: string }[]>(`
            insert into inbox_messages(consumer_name, message_id, payload_hash, processed_at)
            values ('test-event-projection', ?, ?, now()) on conflict do nothing returning message_id`,
          [envelope.eventId, createHash('sha256').update(duplicate.Body!).digest('hex')], 'all', em.getTransactionContext());
          if (!inserted.length) return;
          await em.getConnection().execute(`insert into test_event_projection(wallet_id, applied) values (?, 1)
            on conflict (wallet_id) do update set applied = test_event_projection.applied + 1`,
          [wallet.id], 'run', em.getTransactionContext());
        });
        await sqs.send(new DeleteMessageCommand({ QueueUrl: urls!.events, ReceiptHandle: duplicate.ReceiptHandle! }));
      }
      const [projection] = await sql<{ applied: number }[]>('select applied from test_event_projection where wallet_id = ?', [wallet.id]);
      assert.equal(projection.applied, 1);
    });

    await check('indisponibilidade de fila mantém outbox e agenda backoff persistente', async () => {
      await open();
      const bad = new OutboxPublisher(async () => db.orm, sqs, `${urls!.events}-missing`);
      const now = new Date();
      assert.equal(await bad.publishOnce(now), 'retry');
      const [record] = await sql<{ attempts: number; next_attempt_at: Date; published_at: Date | null }[]>(
        'select attempts, next_attempt_at, published_at from outbox_messages where attempts > 0 order by next_attempt_at desc limit 1');
      assert.equal(record.attempts, 1);
      assert.equal(record.published_at, null);
      assert.ok(new Date(record.next_attempt_at) > now);
      const recovered = new OutboxPublisher(async () => db.orm, sqs, urls!.events);
      const future = new Date(now.getTime() + 5000);
      while (await recovered.publishOnce(future) === 'published') { /* drenar */ }
      await drain(urls!.events);
    });

    await check('parada durante processamento aguarda commit e drena a recepção em curso', async () => {
      const wallet = await open();
      const envelope = request(wallet);
      let unlock!: () => void;
      let announce!: () => void;
      const gate = new Promise<void>((resolve) => { unlock = resolve; });
      const acquired = new Promise<void>((resolve) => { announce = resolve; });
      const holder = db.orm.em.fork().transactional(async (em) => {
        await em.getConnection().execute('select id from wallets where id = ? for update', [wallet.id], 'all', em.getTransactionContext());
        announce(); await gate;
      });
      await Promise.race([acquired, holder]);
      const runningConsumer = consumer();
      await send(envelope);
      const running = runningConsumer.consumeOnce();
      try {
        const deadline = Date.now() + 2500;
        let waiting = false;
        while (Date.now() < deadline) {
          const [{ total }] = await sql<{ total: string }[]>(
            `select count(*)::text as total from pg_stat_activity where datname = ? and wait_event_type = 'Lock'`, [db.dbName]);
          if (total !== '0') { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(waiting, true);
        runningConsumer.stop();
      } finally { unlock(); await holder; }
      assert.equal(await running, 'processed');
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '75.00');
      const polling = new SqsConsumer(financial, sqs, urls!, { waitSeconds: 10 });
      const pending = polling.consumeOnce();
      polling.stop();
      assert.equal(await pending, 'idle');
    });

    await check('runtime integrado inicia os três loops e encerra sem deixar trabalho ativo', async () => {
      const wallet = await open();
      const envelope = request(wallet);
      await send(envelope);
      const runtime = new WorkerRuntime(async () => db.orm, sqs, names);
      const running = runtime.run();
      let completed = false;
      try {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const [processed] = await sql<{ total: string }[]>(
            `select count(*)::text as total from wager_transactions where external_transaction_id = ? and status = 'PROCESSED'`,
            [envelope.data.externalTransactionId]);
          const [pending] = await sql<{ total: string }[]>('select count(*)::text as total from outbox_messages where published_at is null');
          if (processed.total === '1' && pending.total === '0') { completed = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally { runtime.stop(); await running; }
      assert.equal(completed, true);
      assert.equal((await financial.getWallet(wallet.id)).balance.amount, '75.00');
      await drain(urls!.events);
    });

    await check('saldo final de todas as wallets é reconstruído pelo ledger', async () => {
      for (const walletId of wallets) assert.equal((await financial.reconcile(walletId)).consistent, true, walletId);
      const metrics = await telemetry.render(async () => db.orm);
      assert.match(metrics, /wagering_retries_total\{origin="sqs"\} [1-9]/);
      assert.match(metrics, /wagering_retries_total\{origin="outbox"\} [1-9]/);
      assert.match(metrics, /wagering_retries_total\{origin="reference"\} [1-9]/);
      assert.match(metrics, /wagering_dlq_messages_total [1-9]/);
      assert.match(metrics, /wagering_duplicates_total [1-9]/);
    });
  } finally {
    try {
      if (urls) for (const url of Object.values(urls)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    } finally { sqs.destroy(); await db.close(); }
  }
});
