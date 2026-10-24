import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../shared/domain/money';
import type {
  LedgerEntryView,
  LedgerPageResult,
  LedgerReader,
  LedgerSummary,
} from '../../wallet/application/ledger-reader';
import type { LedgerDirection } from '../../wallet/domain/ledger-direction';

interface LedgerRow {
  seq: string;
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

interface SummaryRow {
  stored: string;
  currency: string;
  calculated: string;
  entries: number;
}

/** O saldo reconstruído pode ser negativo se o ledger estiver inconsistente: aceita sinal. */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}

export class MikroOrmLedgerReader implements LedgerReader {
  constructor(private readonly orm: MikroORM) {}

  async findPage(walletId: string, afterSeq: string, limit: number): Promise<LedgerPageResult> {
    const rows = (await this.orm.em.getConnection().execute(
      `select seq::text as seq, id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq asc
        limit ?`,
      [walletId, afterSeq, limit + 1], // uma linha a mais indica se há próxima página
    )) as unknown as LedgerRow[];

    const entries: LedgerEntryView[] = rows.slice(0, limit).map((row) => ({
      seq: row.seq,
      id: row.id,
      transactionId: row.transaction_id,
      direction: row.direction as LedgerDirection,
      money: { amount: row.amount, currency: row.currency },
      balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency },
      createdAt: new Date(row.created_at).toISOString(),
    }));

    return { entries, hasMore: rows.length > limit };
  }

  async summarize(walletId: string): Promise<LedgerSummary | undefined> {
    // Uma única instrução: o PostgreSQL a executa sobre um único retrato dos dados.
    const [row] = (await this.orm.em.getConnection().execute(
      `select w.balance::text as stored,
              w.currency as currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as calculated,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    )) as unknown as SummaryRow[];

    if (!row) {
      return undefined;
    }
    return {
      storedBalance: signedMoney(row.stored, row.currency),
      calculatedBalance: signedMoney(row.calculated, row.currency),
      checkedEntries: row.entries,
    };
  }
}
