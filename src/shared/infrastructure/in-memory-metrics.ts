import type { MetricLabels, Metrics } from '../application/metrics';

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

interface Series<T> {
  labels: MetricLabels;
  data: T;
}

interface HistogramData {
  counts: number[]; // cada posição conta as observações <= ao limite do balde (já cumulativo)
  sum: number;
  count: number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function keyOf(labels: MetricLabels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => compare(a, b)));
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function format(labels: MetricLabels, extra: MetricLabels = {}): string {
  const entries = Object.entries({ ...labels, ...extra });
  if (entries.length === 0) {
    return '';
  }
  return `{${entries.map(([k, v]) => `${k}="${escapeValue(v)}"`).join(',')}}`;
}

/** Registro de métricas em memória, com saída no formato de texto do Prometheus. */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, Map<string, Series<number>>>();
  private readonly histograms = new Map<string, Map<string, Series<HistogramData>>>();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.series(this.counters, name, labels, () => 0).data += by;
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const { data } = this.series<HistogramData>(this.histograms, name, labels, () => ({
      counts: BUCKETS_MS.map(() => 0),
      sum: 0,
      count: 0,
    }));
    BUCKETS_MS.forEach((bound, index) => {
      if (value <= bound) {
        data.counts[index] += 1;
      }
    });
    data.sum += value;
    data.count += 1;
  }

  render(): string {
    const lines: string[] = [];

    for (const [name, bySeries] of [...this.counters].sort(([a], [b]) => compare(a, b))) {
      lines.push(`# TYPE ${name} counter`);
      for (const series of bySeries.values()) {
        lines.push(`${name}${format(series.labels)} ${series.data}`);
      }
    }

    for (const [name, bySeries] of [...this.histograms].sort(([a], [b]) => compare(a, b))) {
      lines.push(`# TYPE ${name} histogram`);
      for (const series of bySeries.values()) {
        BUCKETS_MS.forEach((bound, index) => {
          lines.push(`${name}_bucket${format(series.labels, { le: String(bound) })} ${series.data.counts[index]}`);
        });
        lines.push(`${name}_bucket${format(series.labels, { le: '+Inf' })} ${series.data.count}`);
        lines.push(`${name}_sum${format(series.labels)} ${series.data.sum}`);
        lines.push(`${name}_count${format(series.labels)} ${series.data.count}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  private series<T>(
    store: Map<string, Map<string, Series<T>>>,
    name: string,
    labels: MetricLabels,
    init: () => T,
  ): Series<T> {
    let bySeries = store.get(name);
    if (!bySeries) {
      bySeries = new Map();
      store.set(name, bySeries);
    }
    const key = keyOf(labels);
    let series = bySeries.get(key);
    if (!series) {
      series = { labels: { ...labels }, data: init() };
      bySeries.set(key, series);
    }
    return series;
  }
}
