import type { IntegrationEvent } from './events';

interface OutboxState {
  id: string; aggregateId: string; eventType: string; payload: Record<string, unknown>;
  occurredAt: Date; attempts: number; nextAttemptAt: Date; publishedAt?: Date;
}

export function retryDelay(attempt: number, baseMs = 1000, capMs = 60000): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 20));
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return OutboxMessage.rehydrate({ id: event.eventId, aggregateId: event.aggregateId,
      eventType: event.eventType, payload: { ...event.toJSON() }, occurredAt: event.occurredAt,
      attempts: 0, nextAttemptAt: event.occurredAt });
  }
  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage({ ...state, payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt), nextAttemptAt: new Date(state.nextAttemptAt),
      publishedAt: state.publishedAt ? new Date(state.publishedAt) : undefined });
  }
  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get eventType(): string { return this.state.eventType; }
  get payload(): Readonly<Record<string, unknown>> { return structuredClone(this.state.payload); }
  get occurredAt(): Date { return new Date(this.state.occurredAt); }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date { return new Date(this.state.nextAttemptAt); }
  get publishedAt(): Date | undefined { return this.state.publishedAt ? new Date(this.state.publishedAt) : undefined; }
  isPending(): boolean { return this.state.publishedAt === undefined; }
  isDue(now: Date): boolean { return this.isPending() && this.state.nextAttemptAt <= now; }
  markPublished(at: Date): void {
    if (!this.isPending()) throw new Error('OUTBOX_ALREADY_PUBLISHED');
    this.state.publishedAt = new Date(at);
  }
  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new Error('OUTBOX_ALREADY_PUBLISHED');
    this.state.attempts += 1;
    this.state.nextAttemptAt = new Date(now.getTime() + retryDelay(this.state.attempts - 1));
  }
}
