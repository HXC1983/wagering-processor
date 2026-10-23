import { DomainError } from '../../shared/domain/domain-error';

/** Mesma idempotency key com payload diferente (ou mesma transação externa com outra key). */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** REFUND e ROLLBACK entram no Bloco E. */
export class UnsupportedTransactionKindError extends DomainError {
  readonly code = 'UNSUPPORTED_TRANSACTION_KIND';
}
