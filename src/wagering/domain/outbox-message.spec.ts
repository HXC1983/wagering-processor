import { describe, expect, test } from 'bun:test';
import { IntegrationEvent } from '../../shared/domain/integration-event';
import { OutboxMessage } from './outbox-message';

const NOW = new Date('2026-10-23T15:00:00.000Z');

class TestEvent extends IntegrationEvent<{ value: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 3;

  static make(causationId?: string): TestEvent {
    return new TestEvent({
      eventId: 'e-1',
      aggregateId: 'a-1',
      correlationId: 'c-1',
      causationId,
      occurredAt: NOW,
      data: { value: 1 },
    });
  }
}

describe('IntegrationEvent', () => {
  test('toJSON devolve o envelope com tipo, versão e data ISO', () => {
    expect(TestEvent.make('x-1').toJSON()).toEqual({
      eventId: 'e-1',
      eventType: 'TestEvent',
      aggregateId: 'a-1',
      correlationId: 'c-1',
      causationId: 'x-1',
      occurredAt: '2026-10-23T15:00:00.000Z',
      version: 3,
      data: { value: 1 },
    });
  });

  test('omite causationId quando ausente', () => {
    expect('causationId' in TestEvent.make().toJSON()).toBe(false);
  });
});

describe('OutboxMessage', () => {
  test('enqueue usa o eventId como id e grava o envelope no payload', () => {
    const message = OutboxMessage.enqueue(TestEvent.make());
    expect(message.id).toBe('e-1');
    expect(message.eventType).toBe('TestEvent');
    expect(message.payload.version).toBe(3);
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  test('scheduleRetry aplica backoff exponencial com teto de 5 minutos', () => {
    const message = OutboxMessage.enqueue(TestEvent.make());

    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1_000);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 1_000))).toBe(true);

    message.scheduleRetry(NOW);
    expect(message.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 2_000);

    for (let i = 0; i < 20; i += 1) {
      message.scheduleRetry(NOW);
    }
    expect(message.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 300_000);
  });

  test('markPublished tira a mensagem da fila', () => {
    const message = OutboxMessage.enqueue(TestEvent.make());
    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.publishedAt).toEqual(NOW);
  });
});
