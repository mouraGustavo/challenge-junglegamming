import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/outbox-message';
import { OutboxRecord } from '../persistence/records';
import { structuredLog, telemetry } from '../observability/telemetry';

export class OutboxPublisher {
  constructor(private readonly database: () => Promise<MikroORM>, private readonly sqs: SQSClient,
    private readonly eventsUrl: string) {}

  async publishOnce(now = new Date()): Promise<'idle' | 'published' | 'retry'> {
    const orm = await this.database();
    return orm.em.fork().transactional(async (em) => {
      const rows = await em.getConnection().execute<{ id: string }[]>(`
        select id from outbox_messages where published_at is null and next_attempt_at <= ?
        order by next_attempt_at, id limit 1 for update skip locked`, [now], 'all', em.getTransactionContext());
      if (!rows.length) return 'idle';
      const record = await em.findOneOrFail(OutboxRecord, rows[0].id);
      const message = OutboxMessage.rehydrate(record);
      try {
        await this.sqs.send(new SendMessageCommand({ QueueUrl: this.eventsUrl,
          MessageBody: JSON.stringify(message.payload), MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id }), { abortSignal: AbortSignal.timeout(3000) });
      } catch {
        message.scheduleRetry(now);
        em.assign(record, { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt });
        await em.flush();
        telemetry.retry('outbox');
        structuredLog('warn', 'outbox_retry', { eventId: message.id,
          walletId: message.aggregateId, attempts: message.attempts, correlationId: message.payload.correlationId });
        return 'retry';
      }
      // Falha após o envio e antes deste commit mantém a linha pendente para recuperação.
      message.markPublished(new Date());
      record.publishedAt = message.publishedAt;
      await em.flush();
      return 'published';
    });
  }
}
