import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  PendingReferenceCandidate,
  PendingReferenceReader,
} from '../../wagering/application/reprocess-pending-references.use-case';

export class MikroOrmPendingReferenceReader implements PendingReferenceReader {
  constructor(private readonly orm: MikroORM) {}

  async findDue(limit: number, now: Date): Promise<PendingReferenceCandidate[]> {
    // Usa o índice parcial wager_tx_pending_reference_idx. Sem lock: o worker relê sob a trava da wallet.
    const rows = (await this.orm.em.getConnection().execute(
      `select id, wallet_id
         from wager_transactions
        where status = 'PENDING_REFERENCE'
          and (next_reference_attempt_at is null or next_reference_attempt_at <= ?)
        order by next_reference_attempt_at asc nulls first
        limit ?`,
      [now, limit],
    )) as unknown as Array<{ id: string; wallet_id: string }>;
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }
}
