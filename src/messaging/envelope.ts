import { ApplicationError } from '../application/errors';
import { object, text, wagerInput } from '../application/contracts';

export function parseRequest(body: string | undefined) {
  let value: unknown;
  try { value = JSON.parse(body ?? ''); }
  catch { throw new ApplicationError('INVALID_MESSAGE_JSON', 400); }
  const envelope = object(value);
  const messageId = text(envelope.messageId);
  if (envelope.type !== 'WagerTransactionRequested') throw new ApplicationError('INVALID_MESSAGE_TYPE', 400);
  const occurredAt = text(envelope.occurredAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) {
    throw new ApplicationError('INVALID_MESSAGE_DATE', 400);
  }
  const data = object(envelope.data);
  const payload = wagerInput(data);
  return { messageId, payload, idempotencyKey: text(data.idempotencyKey, 400),
    correlationId: envelope.correlationId === undefined ? messageId : text(envelope.correlationId) };
}
