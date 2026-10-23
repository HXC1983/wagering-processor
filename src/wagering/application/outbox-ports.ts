import type { OutboxMessage } from '../domain/outbox-message';

export interface OutboxBatchScope {
  /**
   * Reserva até `limit` mensagens vencidas (FOR UPDATE SKIP LOCKED): outro publisher
   * concorrente não enxerga as mesmas linhas enquanto a transação estiver aberta.
   */
  claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;
  /** Persiste o novo estado da mensagem (publicada, ou com nova tentativa agendada). */
  save(message: OutboxMessage): Promise<void>;
}

export interface OutboxRunner {
  run<T>(work: (scope: OutboxBatchScope) => Promise<T>): Promise<T>;
}

export interface EventPublisher {
  /** Lança erro se a publicação falhar; a mensagem então é reagendada com backoff. */
  publish(message: OutboxMessage): Promise<void>;
}
