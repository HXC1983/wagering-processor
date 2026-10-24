import { describe, expect, test } from 'bun:test';
import { InMemoryMetrics } from './in-memory-metrics';

describe('InMemoryMetrics', () => {
  test('contador sem rótulos soma e é renderizado', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('requests_total');
    metrics.increment('requests_total', {}, 4);
    expect(metrics.render()).toContain('# TYPE requests_total counter\nrequests_total 5\n');
  });

  test('by = 0 apenas inicializa a série', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('divergences_total', {}, 0);
    expect(metrics.render()).toContain('divergences_total 0');
  });

  test('rótulos separam as séries, na mesma ordem independentemente da ordem de entrada', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('tx_total', { status: 'PROCESSED', kind: 'BET' });
    metrics.increment('tx_total', { kind: 'BET', status: 'PROCESSED' });
    metrics.increment('tx_total', { status: 'REJECTED', kind: 'BET' });
    const text = metrics.render();
    expect(text).toContain('tx_total{status="PROCESSED",kind="BET"} 2');
    expect(text).toContain('tx_total{status="REJECTED",kind="BET"} 1');
  });

  test('valores de rótulo são escapados', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('x_total', { reason: 'a"b\\c' });
    expect(metrics.render()).toContain('x_total{reason="a\\"b\\\\c"} 1');
  });

  test('histograma é cumulativo e fecha em +Inf', () => {
    const metrics = new InMemoryMetrics();
    metrics.observe('latency_ms', 3);
    metrics.observe('latency_ms', 30);
    metrics.observe('latency_ms', 9_000);
    const text = metrics.render();
    expect(text).toContain('latency_ms_bucket{le="5"} 1');
    expect(text).toContain('latency_ms_bucket{le="50"} 2');
    expect(text).toContain('latency_ms_bucket{le="5000"} 2');
    expect(text).toContain('latency_ms_bucket{le="+Inf"} 3');
    expect(text).toContain('latency_ms_sum 9033');
    expect(text).toContain('latency_ms_count 3');
  });
});
