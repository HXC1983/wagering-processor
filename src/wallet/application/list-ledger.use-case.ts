import type { MoneyProps } from '../../shared/domain/money';
import type { LedgerDirection } from '../domain/ledger-direction';
import { WalletNotFoundError } from './errors';
import { decodeCursor, encodeCursor } from './ledger-cursor';
import type { LedgerReader } from './ledger-reader';
import type { WalletReader } from './wallet-reader';

export interface LedgerItem {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItem[];
  nextCursor: string | null;
}

export interface ListLedgerQuery {
  walletId: string;
  cursor?: string;
  limit: number;
}

export class ListLedgerUseCase {
  constructor(
    private readonly wallets: WalletReader,
    private readonly ledger: LedgerReader,
  ) {}

  async execute(query: ListLedgerQuery): Promise<LedgerPage> {
    const afterSeq = query.cursor === undefined ? '0' : decodeCursor(query.cursor);

    if (!(await this.wallets.findById(query.walletId))) {
      throw new WalletNotFoundError(`wallet não encontrada: ${query.walletId}`);
    }

    const page = await this.ledger.findPage(query.walletId, afterSeq, query.limit);
    const last = page.entries[page.entries.length - 1];

    return {
      items: page.entries.map(({ seq: _seq, ...item }) => item),
      nextCursor: page.hasMore && last ? encodeCursor(last.seq) : null,
    };
  }
}
