import { InsufficientFundsError } from '../../wallet/domain/errors';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from '../domain/failure-code';
import { evaluateReversal } from '../domain/reversal-policy';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';

export type ApplyOutcome =
  /** A transação ficou PROCESSED ou REJECTED. `entry` existe só quando o saldo mudou. */
  | { kind: 'applied'; entry: WalletLedgerEntry | undefined }
  /** REFUND/ROLLBACK cuja referência ainda não está disponível. */
  | { kind: 'waiting' };

const applied = (entry?: WalletLedgerEntry): ApplyOutcome => ({ kind: 'applied', entry });

/**
 * Aplica as regras de negócio a uma transação sobre uma wallet já travada.
 * É usado tanto pela API/fila quanto pelo worker de referências pendentes.
 */
export class TransactionApplier {
  constructor(private readonly newId: () => string) {}

  apply(
    wallet: Wallet,
    tx: WagerTransaction,
    now: Date,
    reference?: WagerTransaction,
    existingReversal?: WagerTransaction,
  ): ApplyOutcome {
    if (tx.playerId !== wallet.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
      return applied();
    }
    if (tx.money.currency !== wallet.currency) {
      tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      return applied();
    }

    if (tx.requiresReference()) {
      const verdict = evaluateReversal(tx, reference, existingReversal);
      if (verdict.kind === 'wait') {
        return { kind: 'waiting' };
      }
      if (verdict.kind === 'reject') {
        tx.reject(verdict.code, now, wallet.balance);
        return applied();
      }
      return this.applyReversal(wallet, tx, verdict.reference, now);
    }

    return this.applyMovement(wallet, tx, now);
  }

  private applyMovement(wallet: Wallet, tx: WagerTransaction, now: Date): ApplyOutcome {
    let entry: WalletLedgerEntry | undefined;
    try {
      const movement = { amount: tx.money, transactionId: tx.id, entryId: this.newId(), at: now };
      if (tx.kind === WagerTransactionKind.Bet) {
        entry = wallet.debit(movement);
      } else if (tx.kind === WagerTransactionKind.Win) {
        entry = wallet.credit(movement);
      }
      // LOSS: registra o resultado sem mover saldo.
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        tx.reject(FailureCode.InsufficientFunds, now, wallet.balance);
        return applied();
      }
      throw error;
    }
    tx.markProcessed({ at: now, resultingBalance: wallet.balance });
    return applied(entry);
  }

  private applyReversal(wallet: Wallet, tx: WagerTransaction, reference: WagerTransaction, now: Date): ApplyOutcome {
    const direction = tx.ledgerDirectionFor(reference);
    let entry: WalletLedgerEntry;
    try {
      const movement = { amount: tx.money, transactionId: tx.id, entryId: this.newId(), at: now };
      entry = direction === LedgerDirection.Credit ? wallet.credit(movement) : wallet.debit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // Operacionalmente diferente de uma aposta sem saldo: código próprio.
        tx.reject(FailureCode.ReversalWouldOverdraw, now, wallet.balance);
        return applied();
      }
      throw error;
    }
    tx.markProcessed({ at: now, resultingBalance: wallet.balance, referenceTransactionId: reference.id });
    return applied(entry);
  }
}
