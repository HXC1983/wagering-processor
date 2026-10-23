import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { OutboxBatchScope, OutboxRunner } from '../../wagering/application/outbox-ports';
import type { OutboxMessage } from '../../wagering/domain/outbox-message';
import { outboxFromRow } from './mappers';
import { OutboxRow, OutboxSchema } from './schemas';

class MikroOrmOutboxScope implements OutboxBatchScope {
  private readonly rows = new Map<string, OutboxRow>();

  constructor(private readonly em: EntityManager) {}

  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    // SELECT ... WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now)
    //   ORDER BY occurred_at, id LIMIT n FOR UPDATE SKIP LOCKED
    const rows = await this.em.find(
      OutboxSchema,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    for (const row of rows) {
      this.rows.set(row.id, row);
    }
    return rows.map((row) => outboxFromRow(row));
  }

  async save(message: OutboxMessage): Promise<void> {
    const row = this.rows.get(message.id);
    if (!row) {
      throw new Error(`mensagem ${message.id} não foi reservada nesta transação`);
    }
    const state = message.toState();
    row.attempts = state.attempts;
    row.nextAttemptAt = state.nextAttemptAt ?? null;
    row.publishedAt = state.publishedAt ?? null;
    await this.em.flush();
  }
}

export class MikroOrmOutboxRunner implements OutboxRunner {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (scope: OutboxBatchScope) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork();
    return em.transactional((transactionalEm) => work(new MikroOrmOutboxScope(transactionalEm)));
  }
}
