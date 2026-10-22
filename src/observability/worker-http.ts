import { createServer } from 'node:http';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { telemetry } from './telemetry';

export async function startWorkerHttp(database: () => Promise<MikroORM>, sqs: SQSClient) {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/metrics') {
        response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        response.end(await telemetry.render(database));
      } else if (request.url === '/health/live') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
      } else if (request.url === '/health/ready') {
        const results = await Promise.allSettled([
          database().then((orm) => orm.em.getConnection().execute('select 1')),
          sqs.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: AbortSignal.timeout(3000) }),
        ]);
        const checks = { postgres: results[0].status === 'fulfilled', sqs: results[1].status === 'fulfilled' };
        const ready = checks.postgres && checks.sqs;
        response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: ready ? 'ok' : 'not_ready', checks }));
      } else { response.writeHead(404); response.end(); }
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.METRICS_PORT ?? '9100'), process.env.HOST ?? '127.0.0.1', () => {
      server.off('error', reject); resolve();
    });
  });
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
