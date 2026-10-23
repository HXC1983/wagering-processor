import { DomainError } from '../../shared/domain/domain-error';

/** Payload inválido (contrato), não é rejeição de negócio. */
export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

/** Transição inválida: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}
