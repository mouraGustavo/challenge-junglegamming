/** Barreiras somente de teste. O processo será morto externamente pelo Docker. */
import 'reflect-metadata';
import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../../src/config';
import { createOrm } from '../../src/persistence/orm';
import { FinancialService } from '../../src/application/financial-service';
import { SqsConsumer } from '../../src/messaging/sqs-consumer';
import { resolveQueues } from '../../src/messaging/queues';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';

async function barrier(event: string): Promise<never> {
  console.log(JSON.stringify({ event }));
  setInterval(() => undefined, 1000);
  return new Promise<never>(() => { /* aguardar SIGKILL do processo de teste */ });
}

async function main() {
  const orm = await createOrm();
  const sqs = new SQSClient(config.sqs);
  const urls = await resolveQueues(sqs);
  if (process.argv[2] === 'consumer') {
    class CommitBarrier extends FinancialService {
      override async process(...args: Parameters<FinancialService['process']>) {
        const result = await super.process(...args);
        await barrier('test_after_commit_before_ack');
        return result;
      }
    }
    const consumer = new SqsConsumer(new CommitBarrier(async () => orm), sqs, urls,
      { waitSeconds: 1, visibilitySeconds: 2 });
    while (true) await consumer.consumeOnce();
  } else if (process.argv[2] === 'publisher') {
    sqs.middlewareStack.add((next, context) => async (args) => {
      const result = await next(args);
      if (context.commandName === 'SendMessageCommand') await barrier('test_after_send_before_mark');
      return result;
    }, { step: 'initialize', name: 'testSendBarrier' });
    const publisher = new OutboxPublisher(async () => orm, sqs, urls.events);
    while (true) {
      if (await publisher.publishOnce() === 'idle') await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } else throw new Error('Unknown fixture role');
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
