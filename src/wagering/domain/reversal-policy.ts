import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';

export type ReversalVerdict =
  /** Pode aplicar: devolve a referência já validada. */
  | { kind: 'apply'; reference: WagerTransaction }
  /** A referência ainda não está disponível (inexistente ou ela própria pendente). */
  | { kind: 'wait' }
  | { kind: 'reject'; code: FailureCode };

function allowedReferenceKinds(kind: Kind): readonly Kind[] {
  switch (kind) {
    case Kind.Refund:
      return [Kind.Bet];
    case Kind.Rollback:
      return [Kind.Bet, Kind.Win, Kind.Refund];
    default:
      return [];
  }
}

const reject = (code: FailureCode): ReversalVerdict => ({ kind: 'reject', code });

/**
 * Regras de REFUND e ROLLBACK, em ordem: a primeira que falha decide.
 * `existingReversal` é a reversão já PROCESSADA dessa referência, se houver
 * (interpretação mais estrita que o enunciado: no máximo UMA reversão de qualquer tipo).
 */
export function evaluateReversal(
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  existingReversal: WagerTransaction | undefined,
): ReversalVerdict {
  if (!reference) {
    return { kind: 'wait' };
  }

  const sameContext =
    reference.providerId === tx.providerId &&
    reference.walletId === tx.walletId &&
    reference.playerId === tx.playerId &&
    reference.roundId === tx.roundId &&
    reference.money.currency === tx.money.currency;
  if (!sameContext) {
    return reject(FailureCode.ReferenceMismatch);
  }

  if (!allowedReferenceKinds(tx.kind).includes(reference.kind)) {
    return reject(FailureCode.ReferenceKindNotAllowed);
  }

  switch (reference.status) {
    case Status.Rejected:
    case Status.Failed:
      return reject(FailureCode.ReferenceNotProcessed);
    case Status.Pending:
    case Status.PendingReference:
      return { kind: 'wait' };
    case Status.Processed:
      break;
  }

  if (!reference.money.equals(tx.money)) {
    return reject(FailureCode.AmountMismatch);
  }
  if (existingReversal) {
    return reject(FailureCode.AlreadyReversed);
  }
  return { kind: 'apply', reference };
}
