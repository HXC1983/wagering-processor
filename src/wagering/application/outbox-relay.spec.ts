import { describe, expect, test } from 'bun:test';
import { IntegrationEvent } from '../../shared/domain/integration-event';
import { InMemoryMetrics } from '../../shared/infrastructure/in-memory-metrics';
import { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher, OutboxBatchScope, OutboxRunner } from './outbox-ports';
import { OutboxRelay } from './outbox-relay';

const T0 = new Date('2026-10-24T12:00:00.000Z');

class TestEvent extends IntegrationEvent<{ value: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  static make(id: string): TestEvent {
    return new TestEvent({
      eventId: id,
      aggregateId: 'a-1',
      correlationId: 'c-1',
      occurredAt: T0,
      data: { value: 1 },
    });
  }
}

class FakeRunner implements OutboxRunner {
  constructor(readonly messages: OutboxMessage[]) {}

  async run<T>(work: (scope: OutboxBatchScope) => Promise<T>): Promise<T> {
    return work({
      claimDue: async (limit) => this.messages.filter((m) => m.isPending()).slice(0, limit),
      save: async () => undefined,
    });
  }
}

describe('OutboxRelay: métricas', () => {
  test('publicar registra o atraso desde o commit', async () => {
    const metrics = new InMemoryMetrics();
    const runner = new FakeRunner([OutboxMessage.enqueue(TestEvent.make('e-1'))]);
    const publisher: EventPublisher = { publish: async () => undefined };
    const relay = new OutboxRelay(runner, publisher, {
      metrics,
      clock: () => new Date(T0.getTime() + 250),
    });

    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    const text = metrics.render();
    expect(text).toContain('outbox_publish_delay_ms_count 1');
    expect(text).toContain('outbox_publish_delay_ms_sum 250');
  });

  test('falha de publicação conta um retry e reagenda a mensagem', async () => {
    const metrics = new InMemoryMetrics();
    const message = OutboxMessage.enqueue(TestEvent.make('e-1'));
    const publisher: EventPublisher = {
      publish: async () => {
        throw new Error('broker indisponível');
      },
    };
    const relay = new OutboxRelay(new FakeRunner([message]), publisher, { metrics, clock: () => T0 });

    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(metrics.render()).toContain('retries_total{component="outbox_publish"} 1');
    expect(message.attempts).toBe(1);
    expect(message.isPending()).toBe(true);
  });
});
