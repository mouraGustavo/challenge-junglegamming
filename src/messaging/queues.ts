import { CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SetQueueAttributesCommand,
  type SQSClient } from '@aws-sdk/client-sqs';

export interface QueueNames { input: string; dlq: string; events: string }
export interface QueueUrls { input: string; dlq: string; events: string }
export const queueNames: QueueNames = {
  input: process.env.SQS_INPUT_QUEUE ?? 'wager-transactions.fifo',
  dlq: process.env.SQS_DLQ_QUEUE ?? 'wager-transactions-dlq.fifo',
  events: process.env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo',
};

export async function createQueues(sqs: SQSClient, names = queueNames, maxReceiveCount = 5): Promise<QueueUrls> {
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: names.dlq,
    Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' } }));
  if (!dlq.QueueUrl) throw new Error('DLQ_URL_MISSING');
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
  if (!attrs.Attributes?.QueueArn) throw new Error('DLQ_ARN_MISSING');
  // Criar só com atributos estáveis; atualizar os operacionais permite repetir o setup.
  const input = await sqs.send(new CreateQueueCommand({ QueueName: names.input,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
  if (!input.QueueUrl) throw new Error('INPUT_URL_MISSING');
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: input.QueueUrl, Attributes: {
    VisibilityTimeout: '60', ReceiveMessageWaitTimeSeconds: '10',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attrs.Attributes.QueueArn, maxReceiveCount }),
  } }));
  const events = await sqs.send(new CreateQueueCommand({ QueueName: names.events,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
  if (!events.QueueUrl) throw new Error('EVENTS_URL_MISSING');
  return { input: input.QueueUrl, dlq: dlq.QueueUrl, events: events.QueueUrl };
}

export async function resolveQueues(sqs: SQSClient, names = queueNames): Promise<QueueUrls> {
  const results = await Promise.all([names.input, names.dlq, names.events].map((QueueName) =>
    sqs.send(new GetQueueUrlCommand({ QueueName }), { abortSignal: AbortSignal.timeout(3000) })));
  const [input, dlq, events] = results.map((result) => result.QueueUrl);
  if (!input || !dlq || !events) throw new Error('QUEUE_URL_MISSING');
  return { input, dlq, events };
}
