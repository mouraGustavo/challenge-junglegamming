import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { FinancialService } from '../application/financial-service';
import { OutboxPublisher } from './outbox-publisher';
import { ReferenceWorker } from './reference-worker';
import { queueNames, resolveQueues, type QueueNames, type QueueUrls } from './queues';
import { SqsConsumer } from './sqs-consumer';
import { structuredLog } from '../observability/telemetry';

export class WorkerRuntime {
  private stopping = false;
  private consumer?: SqsConsumer;
  private readonly wakeups = new Set<() => void>();
  constructor(private readonly database: () => Promise<MikroORM>, private readonly sqs: SQSClient,
    private readonly names: QueueNames = queueNames) {}
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.log('workers_stopping');
    this.consumer?.stop();
    for (const wake of this.wakeups) wake();
  }
  async run(): Promise<void> {
    let urls: QueueUrls | undefined;
    while (!this.stopping && !urls) {
      try { urls = await resolveQueues(this.sqs, this.names); }
      catch { this.log('queue_discovery_failed'); await this.pause(1000); }
    }
    if (!urls || this.stopping) return;
    const financial = new FinancialService(this.database);
    this.consumer = new SqsConsumer(financial, this.sqs, urls);
    const publisher = new OutboxPublisher(this.database, this.sqs, urls.events);
    const references = new ReferenceWorker(this.database, financial);
    this.log('workers_started');
    await Promise.all([
      this.loop('consumer', async () => (await this.consumer!.consumeOnce()) !== 'idle', 100),
      this.loop('outbox', async () => (await publisher.publishOnce()) === 'published', 250),
      this.loop('references', async () => (await references.runOnce()) > 0, 1000),
    ]);
    this.log('workers_drained');
  }
  private async loop(name: string, step: () => Promise<boolean>, idleMs: number): Promise<void> {
    while (!this.stopping) {
      try { if (!await step()) await this.pause(idleMs); }
      catch (error) {
        if (this.stopping) break;
        this.log('worker_iteration_failed', { worker: name, errorType: error instanceof Error ? error.name : 'unknown' });
        await this.pause(1000);
      }
    }
  }
  private pause(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); this.wakeups.delete(wake); resolve(); };
      const timer = setTimeout(wake, ms);
      this.wakeups.add(wake);
    });
  }
  private log(event: string, fields: Record<string, unknown> = {}): void {
    structuredLog('info', event, fields);
  }
}
