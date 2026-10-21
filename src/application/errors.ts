/** Erros de contrato/aplicação; rejeições financeiras ficam no resultado persistido. */
export class ApplicationError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = 'ApplicationError';
  }
}

export function databaseCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return databaseCode(error.cause);
  return undefined;
}

export function isTransientInfrastructure(error: unknown): boolean {
  const code = databaseCode(error);
  if (code && (/^08/.test(code) || [
    '40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', '53300',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
  ].includes(code))) return true;
  if (error instanceof Error && error.name === 'KnexTimeoutError') return true;
  return typeof error === 'object' && error !== null && 'cause' in error
    ? isTransientInfrastructure(error.cause) : false;
}
