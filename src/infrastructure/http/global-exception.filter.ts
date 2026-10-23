import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../shared/domain/domain-error';

/** Taxonomia de erros -> status HTTP. Erros de domínio sem entrada aqui caem em 422. */
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_REQUEST: 400,
  INVALID_MONEY: 400,
  INVALID_AMOUNT: 400,
  INVALID_WALLET: 400,
  INVALID_TRANSACTION: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  UNSUPPORTED_TRANSACTION_KIND: 422,
};

/** Códigos do PostgreSQL e de rede que indicam falha transitória (o provedor pode reenviar). */
const TRANSIENT_CODES = new Set([
  '40P01', // deadlock
  '40001', // serialization failure
  '57P01', // admin shutdown
  '57P02',
  '57P03', // cannot connect now
  '08000',
  '08001',
  '08003',
  '08006', // connection failure
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

function isTransient(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) {
    return false;
  }
  const e = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) {
    return true;
  }
  if (typeof e.name === 'string' && /Connection|Deadlock|LockWaitTimeout/.test(e.name)) {
    return true;
  }
  return isTransient(e.cause, depth + 1);
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'erro interno';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = 'HTTP_ERROR';
      message = exception.message;
    } else if (exception instanceof DomainError) {
      status = STATUS_BY_CODE[exception.code] ?? 422;
      code = exception.code;
      message = exception.message;
    } else if (isTransient(exception)) {
      status = 503;
      code = 'SERVICE_UNAVAILABLE';
      message = 'falha transitória de infraestrutura; tente novamente';
      res.setHeader('Retry-After', '1');
    }

    if (status >= 500) {
      // Log estruturado; sem o payload da requisição.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'request failed',
          code,
          error: exception instanceof Error ? exception.message : String(exception),
        }),
      );
    }

    if (!res.headersSent) {
      res.status(status).json({ error: { code, message } });
    }
  }
}
