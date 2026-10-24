import { describe, expect, test } from 'bun:test';
import { Money } from '../../shared/domain/money';
import { FailureCode } from './failure-code';
import { evaluateReversal } from './reversal-policy';
import { CreateWagerTransactionProps, WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';

const NOW = new Date('2026-10-23T15:00:00.000Z');
const brl = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

function make(overrides: Partial<CreateWagerTransactionProps> & { status?: Status } = {}): WagerTransaction {
  const { status = Status.Processed, ...props } = overrides;
  return WagerTransaction.rehydrate({
    id: 't-ref',
    providerId: 'provider-a',
    externalTransactionId: 'ext-ref',
    idempotencyKey: 'provider-a:ext-ref',
    payloadHash: 'h',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'r-1',
    gameId: 'g-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
    status,
    ...props,
  });
}

function reversal(kind: Kind.Refund | Kind.Rollback = Kind.Refund, overrides: Partial<CreateWagerTransactionProps> = {}) {
  return make({
    id: 't-rev',
    externalTransactionId: 'ext-rev',
    idempotencyKey: 'provider-a:ext-rev',
    kind,
    referenceExternalTransactionId: 'ext-ref',
    status: Status.Pending,
    ...overrides,
  });
}

describe('evaluateReversal: referência ausente ou pendente', () => {
  test('sem referência: espera', () => {
    expect(evaluateReversal(reversal(), undefined, undefined)).toEqual({ kind: 'wait' });
  });

  test('referência ainda pendente: espera', () => {
    expect(evaluateReversal(reversal(), make({ status: Status.PendingReference }), undefined)).toEqual({ kind: 'wait' });
    expect(evaluateReversal(reversal(), make({ status: Status.Pending }), undefined)).toEqual({ kind: 'wait' });
  });
});

describe('evaluateReversal: aplicação', () => {
  test('REFUND de uma BET processada com o mesmo valor: aplica', () => {
    const reference = make();
    expect(evaluateReversal(reversal(), reference, undefined)).toEqual({ kind: 'apply', reference });
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund])('ROLLBACK pode referenciar %s', (kind) => {
    const reference = make({ kind });
    expect(evaluateReversal(reversal(Kind.Rollback), reference, undefined)).toEqual({ kind: 'apply', reference });
  });
});

describe('evaluateReversal: rejeições', () => {
  const code = (tx: WagerTransaction, reference: WagerTransaction, existing?: WagerTransaction) => {
    const verdict = evaluateReversal(tx, reference, existing);
    return verdict.kind === 'reject' ? verdict.code : verdict.kind;
  };

  test.each([Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])('REFUND não pode referenciar %s', (kind) => {
    expect(code(reversal(), make({ kind, money: brl('25.00') }))).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test.each([Kind.Loss, Kind.Rollback, Kind.Opening])('ROLLBACK não pode referenciar %s', (kind) => {
    expect(code(reversal(Kind.Rollback), make({ kind }))).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test.each([
    ['carteira', { walletId: 'w-2' }],
    ['jogador', { playerId: 'p-2' }],
    ['rodada', { roundId: 'r-2' }],
    ['provedor', { providerId: 'provider-b' }],
    ['moeda', { money: brl('25.00', 'USD') }],
  ])('contexto diferente (%s) gera REFERENCE_MISMATCH', (_name, overrides) => {
    expect(code(reversal(), make(overrides as Partial<CreateWagerTransactionProps>))).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  test.each([Status.Rejected, Status.Failed])('referência %s gera REFERENCE_NOT_PROCESSED', (status) => {
    expect(code(reversal(), make({ status }))).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('valor diferente da referência gera AMOUNT_MISMATCH', () => {
    expect(code(reversal(Kind.Refund, { money: brl('20.00') }), make())).toBe(FailureCode.AmountMismatch);
  });

  test('referência já revertida gera ALREADY_REVERSED', () => {
    const existing = make({ id: 't-other', kind: Kind.Refund });
    expect(code(reversal(), make(), existing)).toBe(FailureCode.AlreadyReversed);
    expect(code(reversal(Kind.Rollback), make(), existing)).toBe(FailureCode.AlreadyReversed);
  });

  test('a ordem das regras: contexto antes do tipo, tipo antes do valor', () => {
    expect(code(reversal(), make({ kind: Kind.Win, walletId: 'w-2' }))).toBe(FailureCode.ReferenceMismatch);
    expect(code(reversal(Kind.Refund, { money: brl('1.00') }), make({ kind: Kind.Win }))).toBe(
      FailureCode.ReferenceKindNotAllowed,
    );
  });
});
