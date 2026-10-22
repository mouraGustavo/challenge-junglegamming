import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../src/config';
import { createQueues } from '../src/messaging/queues';

async function main(): Promise<void> {
  const sqs = new SQSClient(config.sqs);
  try { console.log(JSON.stringify(await createQueues(sqs), null, 2)); }
  finally { sqs.destroy(); }
}
void main().catch(() => {
  console.error('Queue initialization failed. Check that Docker Compose is healthy.');
  process.exitCode = 1;
});
