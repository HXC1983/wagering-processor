import { describe, expect, test } from 'bun:test';
import { InMemoryMetrics } from '../infrastructure/in-memory-metrics';
import { noopMetrics, registerKnownSeries } from './metrics';

describe('registerKnownSeries', () => {
  test('inicializa em 0 todas as séries exigidas pelo enunciado', () => {
    const metrics = new InMemoryMetrics();
    registerKnownSeries(metrics);
    const text = metrics.render();
    for (const series of [
      'reconciliation_divergences_total 0',
      'duplicates_detected_total{source="idempotency_key"} 0',
      'duplicates_detected_total{source="inbox"} 0',
      'retries_total{component="outbox_publish"} 0',
      'retries_total{component="sqs_consumer"} 0',
      'retries_total{component="pending_reference"} 0',
      'dlq_messages_total{reason="permanent"} 0',
      'dlq_messages_total{reason="retries-exhausted"} 0',
      'lock_conflicts_total{kind="wallet_wait"} 0',
      'lock_conflicts_total{kind="idempotency_race"} 0',
    ]) {
      expect(text).toContain(series);
    }
  });

  test('noopMetrics aceita chamadas sem efeito', () => {
    expect(() => {
      noopMetrics.increment('x_total');
      noopMetrics.observe('x_ms', 1);
    }).not.toThrow();
  });
});
