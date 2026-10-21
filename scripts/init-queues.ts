import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../src/config';

async function main(): Promise<void> {
  const sqs = new SQSClient(config.sqs);
  try {
    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo',
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' },
    }));
    if (!dlq.QueueUrl) throw new Error('DLQ URL missing');
    const attributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }));
    const arn = attributes.Attributes?.QueueArn;
    if (!arn) throw new Error('DLQ ARN missing');
    const input = await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-transactions.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
        ReceiveMessageWaitTimeSeconds: '10',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }),
      },
    }));
    const events = await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-events.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    console.log(JSON.stringify({ input: input.QueueUrl, dlq: dlq.QueueUrl, events: events.QueueUrl }, null, 2));
  } finally {
    sqs.destroy();
  }
}

void main().catch(() => {
  console.error('Queue initialization failed. Check that Docker Compose is healthy.');
  process.exitCode = 1;
});
