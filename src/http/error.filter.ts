import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import { ApplicationError, databaseCode, isTransientInfrastructure } from '../application/errors';
import { DomainError } from '../domain/errors';

interface HttpResponse { status(code: number): HttpResponse; json(value: unknown): void }

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    if (error instanceof ApplicationError) {
      response.status(error.status).json({ code: error.code });
      return;
    }
    if (error instanceof DomainError) {
      response.status(400).json({ code: error.code });
      return;
    }
    const code = databaseCode(error);
    const transient = isTransientInfrastructure(error);
    console.error(JSON.stringify({ level: 'error', code: transient ? 'INFRASTRUCTURE_UNAVAILABLE' : 'UNEXPECTED_ERROR',
      ...(code ? { databaseCode: code } : {}) }));
    response.status(transient ? 503 : 500).json({ code: transient ? 'INFRASTRUCTURE_UNAVAILABLE' : 'INTERNAL_ERROR' });
  }
}
