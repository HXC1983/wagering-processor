import type { MikroORM } from '@mikro-orm/postgresql';

export interface OutboxLag {
  pending: number;
  oldestAgeSeconds: number;
}

/** Lê, no momento da consulta, quantas mensagens aguardam publicação e a idade da mais antiga. */
export class OutboxLagProbe {
  constructor(private readonly orm: MikroORM) {}

  async snapshot(): Promise<OutboxLag> {
    // Usa o índice parcial outbox_pending_idx (published_at IS NULL).
    const [row] = (await this.orm.em.getConnection().execute(
      `select count(*)::int as pending,
              coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as oldest
         from outbox_messages
        where published_at is null`,
    )) as unknown as Array<{ pending: number; oldest: number }>;
    return { pending: row.pending, oldestAgeSeconds: Math.max(0, row.oldest) };
  }
}
