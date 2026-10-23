import { DomainError } from '../../shared/domain/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
}

export class LedgerInconsistencyError extends DomainError {
  readonly code = 'LEDGER_INCONSISTENT';
}
