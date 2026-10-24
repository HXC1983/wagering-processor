export type MetricLabels = Record<string, string>;

export interface Metrics {
  /** Soma `by` ao contador (cria a série se não existir; `by = 0` apenas a inicializa). */
  increment(name: string, labels?: MetricLabels, by?: number): void;
  /** Registra uma observação (em milissegundos) em um histograma. */
  observe(name: string, value: number, labels?: MetricLabels): void;
}

export const MetricName = {
  ReconciliationDivergences: 'reconciliation_divergences_total',
} as const;
