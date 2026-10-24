import type { LogFn } from '../../shared/application/log';
import { MetricName, Metrics, noopMetrics } from '../../shared/application/metrics';
import type { EventPublisher, OutboxRunner } from './outbox-ports';

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
}

export interface OutboxRelayOptions {
  batchSize?: number;
  clock?: () => Date;
  log?: LogFn;
  metrics?: Metrics;
}

/**
 * Um ciclo do publicador da outbox: reserva um lote, publica cada mensagem e grava o
 * resultado, tudo em uma transação. Se o processo morrer no meio, a transação é desfeita
 * e outra instância publica o lote (possível duplicidade; nunca perda).
 */
export class OutboxRelay {
  private readonly clock: () => Date;
  private readonly log: LogFn;
  private readonly metrics: Metrics;
  readonly batchSize: number;

  constructor(
    private readonly runner: OutboxRunner,
    private readonly publisher: EventPublisher,
    options: OutboxRelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.clock = options.clock ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.metrics = options.metrics ?? noopMetrics;
  }

  async runOnce(): Promise<RelayResult> {
    return this.runner.run(async (scope) => {
      const messages = await scope.claimDue(this.batchSize, this.clock());
      let published = 0;
      let failed = 0;

      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          const at = this.clock();
          message.markPublished(at);
          published += 1;
          // Atraso da outbox: do commit da transação financeira até a publicação.
          this.metrics.observe(
            MetricName.OutboxPublishDelayMs,
            Math.max(0, at.getTime() - message.occurredAt.getTime()),
          );
        } catch (error) {
          message.scheduleRetry(this.clock());
          failed += 1;
          this.metrics.increment(MetricName.Retries, { component: 'outbox_publish' });
          this.log('warn', 'outbox publish failed', {
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await scope.save(message);
      }

      return { claimed: messages.length, published, failed };
    });
  }
}
