import 'reflect-metadata';
import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config';
import { createOrm } from './persistence/orm';
import { WorkerRuntime } from './messaging/worker-runtime';
import { startWorkerHttp } from './observability/worker-http';

async function main(): Promise<void> {
  const orm = await createOrm(false);
  const sqs = new SQSClient(config.sqs);
  const runtime = new WorkerRuntime(async () => orm, sqs);
  const stop = () => runtime.stop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const http = await startWorkerHttp(async () => orm, sqs);
  try { await runtime.run(); }
  finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await http.close();
    sqs.destroy();
    await orm.close(true);
  }
}
void main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', event: 'worker_bootstrap_failed',
    errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
});
