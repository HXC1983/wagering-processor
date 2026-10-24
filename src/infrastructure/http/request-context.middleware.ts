import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { LogFn } from '../../shared/application/log';

const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SILENT_PREFIXES = ['/health', '/metrics'];

/**
 * Garante um X-Correlation-Id por requisição (reaproveita o do cliente, se for válido) e
 * registra uma linha de log por requisição. Não registra corpo nem valores: só método, rota,
 * status e duração.
 */
export function requestContext(log: LogFn) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.headers['x-correlation-id'] = correlationId; // os controllers leem daqui
    res.setHeader('X-Correlation-Id', correlationId);

    const startedAt = performance.now();
    res.on('finish', () => {
      if (SILENT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
        return;
      }
      log('info', 'http request', {
        correlationId,
        method: req.method,
        route: req.route?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    next();
  };
}
