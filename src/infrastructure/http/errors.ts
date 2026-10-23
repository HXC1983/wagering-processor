import { DomainError } from '../../shared/domain/domain-error';

/** Requisição malformada: campo ausente, tipo errado, header obrigatório faltando. */
export class InvalidRequestError extends DomainError {
  readonly code = 'INVALID_REQUEST';
}
