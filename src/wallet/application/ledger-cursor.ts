import { DomainError } from '../../shared/domain/domain-error';

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';
}

// Até 18 dígitos: cabe com folga em um bigint e impede estouro numérico no banco.
const SEQ_PATTERN = /^[1-9][0-9]{0,17}$/;

/** Cursor opaco para o cliente: base64url de um JSON com versão. */
export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ v: 1, seq })).toString('base64url');
}

export function decodeCursor(cursor: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('cursor inválido');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidCursorError('cursor inválido');
  }
  const { v, seq } = parsed as { v?: unknown; seq?: unknown };
  if (v !== 1 || typeof seq !== 'string' || !SEQ_PATTERN.test(seq)) {
    throw new InvalidCursorError('cursor inválido');
  }
  return seq;
}
