export type MetricLabels = Record<string, string>;

export interface Metrics {
  /** Soma `by` ao contador (cria a série se não existir; `by = 0` apenas a inicializa). */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** Registra uma observação (em milissegundos) em um histograma. */
  observe(name: string, value: number, labels?: MetricLabels): void;
}

/** Usado quando nenhuma métrica é injetada (testes unitários, por exemplo). */
export const noopMetrics: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
};

export const MetricName = {
  ReconciliationDivergences: 'reconciliation_divergences_total',
  TransactionsTotal: 'wager_transactions_total',
  DuplicatesDetected: 'duplicates_detected_total',
  Retries: 'retries_total',
  DlqMessages: 'dlq_messages_total',
  LockConflicts: 'lock_conflicts_total',
  LockWaitMs: 'wallet_lock_wait_ms',
  ProcessingMs: 'transaction_processing_ms',
  OutboxPublishDelayMs: 'outbox_publish_delay_ms',
} as const;

/**
 * O PostgreSQL não informa que uma requisição esperou por uma trava; então uma espera pela
 * carteira acima deste limite conta como "conflito de lock" (aproximação documentada).
 */
export const LOCK_CONFLICT_THRESHOLD_MS = 25;

/** Inicializa em 0 as séries conhecidas, para aparecerem em /metrics antes do primeiro evento. */
export function registerKnownSeries(metrics: Metrics): void {
  metrics.increment(MetricName.ReconciliationDivergences, {}, 0);
  for (const source of ['idempotency_key', 'inbox']) {
    metrics.increment(MetricName.DuplicatesDetected, { source }, 0);
  }
  for (const component of ['outbox_publish', 'sqs_consumer', 'pending_reference']) {
    metrics.increment(MetricName.Retries, { component }, 0);
  }
  for (const reason of ['permanent', 'retries-exhausted']) {
    metrics.increment(MetricName.DlqMessages, { reason }, 0);
  }
  for (const kind of ['wallet_wait', 'idempotency_race']) {
    metrics.increment(MetricName.LockConflicts, { kind }, 0);
  }
}
