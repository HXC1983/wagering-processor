import { DomainError } from '../../shared/domain/domain-error';

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}
