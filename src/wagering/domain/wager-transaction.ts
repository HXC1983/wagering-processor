import { Money } from '../../shared/domain/money';
import { LedgerDirection, invertDirection } from '../../wallet/domain/ledger-direction';
import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor, e não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  resultingBalance?: Money;
  processedAt?: Date;
}

function assertNonBlank(field: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidTransactionError(`campo obrigatório ausente ou vazio: ${field}`);
  }
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _resultingBalance: Money | undefined;
  private _processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._resultingBalance = state.resultingBalance;
    this._processedAt = state.processedAt;
  }

  /** Transação externa (API ou fila). Nasce em PENDING. OPENING é interno e não passa por aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING é interno e não pode ser submetida');
    }
    return WagerTransaction.build(props);
  }

  /** Crédito de abertura da wallet (uso interno). */
  static createOpening(
    props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>,
  ): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    assertNonBlank('id', props.id);
    assertNonBlank('providerId', props.providerId);
    assertNonBlank('externalTransactionId', props.externalTransactionId);
    assertNonBlank('idempotencyKey', props.idempotencyKey);
    assertNonBlank('payloadHash', props.payloadHash);
    assertNonBlank('walletId', props.walletId);
    assertNonBlank('playerId', props.playerId);
    assertNonBlank('roundId', props.roundId);
    assertNonBlank('gameId', props.gameId);

    if (props.money.isNegative()) {
      throw new InvalidTransactionError('o valor da transação não pode ser negativo');
    }
    // LOSS não move saldo, então aceita zero; os demais exigem valor positivo.
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionError(`${props.kind} exige valor positivo`);
    }

    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference) {
      assertNonBlank('referenceExternalTransactionId', props.referenceExternalTransactionId ?? '');
    }

    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições (estados terminais não mudam mais)

  markProcessed(params: { at: Date; resultingBalance: Money; referenceTransactionId?: string }): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = params.at;
    this._resultingBalance = params.resultingBalance;
    this._referenceTransactionId = params.referenceTransactionId ?? this._referenceTransactionId;
  }

  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
  }

  /** observedBalance: saldo da wallet no momento da rejeição (para o replay idempotente). */
  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultingBalance = observedBalance ?? this._resultingBalance;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Sentido do lançamento. ROLLBACK é o inverso do lançamento da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError(
            'ROLLBACK exige a transação de referência para definir o sentido do lançamento',
          );
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS não gera lançamento no ledger');
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      resultingBalance: this._resultingBalance,
      processedAt: this._processedAt,
    };
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `transição inválida (${action}) a partir do estado terminal ${this._status}`,
      );
    }
  }
}
