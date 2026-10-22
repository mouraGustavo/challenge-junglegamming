import type { MikroORM } from '@mikro-orm/postgresql';

type RetryOrigin = 'sql' | 'sqs' | 'ack' | 'outbox' | 'reference';
type Counter = 'duplicates' | 'idempotency_conflicts' | 'dlq_messages' | 'lock_conflicts' | 'reconciliation_divergences';
const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/** Contadores são telemetria por processo, nunca garantia de idempotência. */
export class Telemetry {
  private readonly counters = new Map<Counter, number>();
  private readonly retries = new Map<RetryOrigin, number>();
  private readonly latencyBuckets = buckets.map(() => 0);
  private latencyCount = 0;
  private latencySum = 0;
  increment(name: Counter): void { this.counters.set(name, (this.counters.get(name) ?? 0) + 1); }
  retry(origin: RetryOrigin): void { this.retries.set(origin, (this.retries.get(origin) ?? 0) + 1); }
  observeProcessing(seconds: number): void {
    this.latencyCount += 1;
    this.latencySum += seconds;
    buckets.forEach((bound, index) => { if (seconds <= bound) this.latencyBuckets[index] += 1; });
  }

  async render(database: () => Promise<MikroORM>): Promise<string> {
    const lines = ['# TYPE wagering_process_uptime_seconds gauge', `wagering_process_uptime_seconds ${process.uptime()}`];
    for (const name of ['duplicates', 'idempotency_conflicts', 'dlq_messages', 'lock_conflicts', 'reconciliation_divergences'] as Counter[]) {
      lines.push(`# TYPE wagering_${name}_total counter`, `wagering_${name}_total ${this.counters.get(name) ?? 0}`);
    }
    lines.push('# TYPE wagering_retries_total counter');
    for (const origin of ['sql', 'sqs', 'ack', 'outbox', 'reference'] as RetryOrigin[]) {
      lines.push(`wagering_retries_total{origin="${origin}"} ${this.retries.get(origin) ?? 0}`);
    }
    lines.push('# TYPE wagering_processing_duration_seconds histogram');
    buckets.forEach((bound, index) => lines.push(`wagering_processing_duration_seconds_bucket{le="${bound}"} ${this.latencyBuckets[index]}`));
    lines.push(`wagering_processing_duration_seconds_bucket{le="+Inf"} ${this.latencyCount}`,
      `wagering_processing_duration_seconds_count ${this.latencyCount}`,
      `wagering_processing_duration_seconds_sum ${this.latencySum}`);
    try {
      const orm = await database();
      const sql = orm.em.getConnection();
      const [states, pending] = await Promise.all([
        sql.execute<{ status: string; total: string }[]>('select status, count(*)::text as total from wager_transactions group by status'),
        sql.execute<{ total: string; lag: string }[]>(`select count(*)::text as total,
          greatest(coalesce(extract(epoch from (now() - min(occurred_at))), 0), 0)::text as lag
          from outbox_messages where published_at is null`),
      ]);
      lines.push('# TYPE wagering_transactions gauge');
      for (const status of ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']) {
        lines.push(`wagering_transactions{status="${status}"} ${states.find((row) => row.status === status)?.total ?? '0'}`);
      }
      lines.push('# TYPE wagering_outbox_pending gauge', `wagering_outbox_pending ${pending[0].total}`,
        '# TYPE wagering_outbox_lag_seconds gauge', `wagering_outbox_lag_seconds ${pending[0].lag}`,
        '# TYPE wagering_database_up gauge', 'wagering_database_up 1');
    } catch { lines.push('# TYPE wagering_database_up gauge', 'wagering_database_up 0'); }
    return `${lines.join('\n')}\n`;
  }
}

export const telemetry = new Telemetry();

export function structuredLog(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  console.log(JSON.stringify({ level, event, correlationId: null, messageId: null,
    transactionId: null, walletId: null, providerId: null, ...defined }));
}
