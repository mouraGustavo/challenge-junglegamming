import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand,
  SendMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { ApplicationError } from '../application/errors';
import { DomainError } from '../domain/errors';
import { FinancialService } from '../application/financial-service';
import { parseRequest } from './envelope';
import type { QueueUrls } from './queues';
import { structuredLog, telemetry } from '../observability/telemetry';

interface ConsumerOptions { maxAttempts?: number; retryBaseSeconds?: number; waitSeconds?: number; visibilitySeconds?: number }
export type ConsumerOutcome = 'idle' | 'processed' | 'retry' | 'dlq';

export class SqsConsumer {
  private stopping = false;
  constructor(private readonly financial: FinancialService, private readonly sqs: SQSClient,
    private readonly urls: QueueUrls, private readonly options: ConsumerOptions = {}) {}

  stop(): void { this.stopping = true; }

  async consumeOnce(): Promise<ConsumerOutcome> {
    if (this.stopping) return 'idle';
    let received;
    try {
      received = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.urls.input,
        MaxNumberOfMessages: 1, WaitTimeSeconds: this.options.waitSeconds ?? 10,
        VisibilityTimeout: this.options.visibilitySeconds ?? 60,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      // Drenar a recepção evita abandonar no broker uma resposta que ainda
      // possa entregar uma mensagem. Se ela chegar após stop, devolver abaixo.
      }), { abortSignal: AbortSignal.timeout(((this.options.waitSeconds ?? 10) + 5) * 1000) });
    } catch (error) { if (this.stopping) return 'idle'; throw error; }
    const message = received.Messages?.[0];
    if (!message?.ReceiptHandle) return 'idle';
    if (this.stopping) { await this.visibility(message, 0); return 'idle'; }
    // Renovar visibilidade não é garantia financeira; reentrega continua segura.
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      renewal ??= this.visibility(message, this.options.visibilitySeconds ?? 60).catch(() => {
        this.log('visibility_extension_failed', message);
      }).finally(() => { renewal = undefined; });
    }, Math.min(15000, (this.options.visibilitySeconds ?? 60) * 500));
    try { return await this.handle(message); }
    finally { clearInterval(heartbeat); await renewal; }
  }

  private async handle(message: Message): Promise<ConsumerOutcome> {
    let parsed: ReturnType<typeof parseRequest> | undefined;
    try {
      parsed = parseRequest(message.Body);
      const result = await this.financial.process(parsed.payload, parsed.idempotencyKey, {
        correlationId: parsed.correlationId, causationId: parsed.messageId,
        inbox: { consumerName: 'wager-transactions', messageId: parsed.messageId },
      });
      // Se o envio à DLQ falhou após salvar FAILED, uma nova entrega ainda
      // precisa encaminhar o comando. Replay terminal não pode apagar essa etapa.
      if (result.status === 'FAILED') throw new ApplicationError(result.failureCode ?? 'INFRASTRUCTURE_RETRY_EXHAUSTED', 422);
      this.log('wager_message_committed', message, { correlationId: parsed.correlationId,
        messageId: parsed.messageId, transactionId: result.transactionId, walletId: parsed.payload.walletId,
        providerId: parsed.payload.providerId, status: result.status, idempotentReplay: result.idempotentReplay });
    } catch (error) {
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const permanent = (error instanceof ApplicationError && error.status < 500) || error instanceof DomainError;
      if (permanent || attempts >= (this.options.maxAttempts ?? 5)) {
        const code = permanent ? error.code : 'INFRASTRUCTURE_RETRY_EXHAUSTED';
        if (!permanent && parsed) {
          try {
            await this.financial.process(parsed.payload, parsed.idempotencyKey, {
              correlationId: parsed.correlationId, causationId: parsed.messageId,
              inbox: { consumerName: 'wager-transactions', messageId: parsed.messageId },
              terminalFailure: 'INFRASTRUCTURE_RETRY_EXHAUSTED',
            });
          } catch {
            // Banco ainda indisponível: preservar o comando na DLQ é o registro auditável.
            this.log('failure_audit_unavailable', message);
          }
        }
        await this.sqs.send(new SendMessageCommand({ QueueUrl: this.urls.dlq, MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',
          MessageDeduplicationId: message.MessageId!, MessageAttributes: {
            failureCode: { DataType: 'String', StringValue: code },
          } }), { abortSignal: AbortSignal.timeout(3000) });
        telemetry.increment('dlq_messages');
        // DLQ primeiro. Falha antes do delete pode duplicar, mas nunca perder o comando.
        await this.ack(message);
        this.log('message_dlq', message, { failureCode: code, attempts,
          correlationId: parsed?.correlationId, messageId: parsed?.messageId,
          walletId: parsed?.payload.walletId, providerId: parsed?.payload.providerId });
        return 'dlq';
      }
      const seconds = Math.min(60, (this.options.retryBaseSeconds ?? 2) * 2 ** Math.min(attempts - 1, 5));
      await this.visibility(message, seconds);
      telemetry.retry('sqs');
      this.log('message_retry', message, { attempts, nextVisibilitySeconds: seconds,
        correlationId: parsed?.correlationId, messageId: parsed?.messageId,
        walletId: parsed?.payload.walletId, providerId: parsed?.payload.providerId });
      return 'retry';
    }
    // O caso de uso só resolve depois do commit. Falha de ack não vira FAILED nem DLQ.
    try { await this.ack(message); }
    catch {
      telemetry.retry('ack');
      this.log('ack_retry', message);
      await this.visibility(message, this.options.retryBaseSeconds ?? 2);
      return 'retry';
    }
    return 'processed';
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.urls.input, ReceiptHandle: message.ReceiptHandle! }),
      { abortSignal: AbortSignal.timeout(3000) });
  }
  private async visibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.urls.input,
      ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: seconds }), { abortSignal: AbortSignal.timeout(3000) });
  }
  private log(event: string, message: Message, fields: Record<string, unknown> = {}): void {
    structuredLog('info', event, { correlationId: message.MessageId ?? null,
      messageId: message.MessageId ?? null, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) });
  }
}
