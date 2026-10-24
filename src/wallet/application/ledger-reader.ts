import type { Money, MoneyProps } from '../../shared/domain/money';
import type { LedgerDirection } from '../domain/ledger-direction';

export interface LedgerEntryView {
  /** Posição no ledger; interna: nunca é exposta, só serve para montar o cursor. */
  seq: string;
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageResult {
  entries: LedgerEntryView[];
  hasMore: boolean;
}

export interface LedgerSummary {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerReader {
  /** Lançamentos da carteira com seq > afterSeq, em ordem crescente de seq. */
  findPage(walletId: string, afterSeq: string, limit: number): Promise<LedgerPageResult>;
  /** Saldo guardado e saldo reconstruído pelo ledger, lidos em um único retrato consistente. */
  summarize(walletId: string): Promise<LedgerSummary | undefined>;
}
