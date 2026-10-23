import { describe, expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message';

const NOW = new Date('2026-10-23T15:00:00.000Z');
const LATER = new Date('2026-10-23T15:00:05.000Z');

const base = { messageId: 'm-1', consumerName: 'c-1', payloadHash: 'h-1', receivedAt: NOW };

describe('InboxMessage', () => {
  test('nasce recebida e ainda não processada', () => {
    const message = InboxMessage.receive(base);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('markProcessed registra a data uma única vez', () => {
    const message = InboxMessage.receive(base);
    message.markProcessed(NOW);
    message.markProcessed(LATER);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(NOW);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const message = InboxMessage.rehydrate({ ...base, processedAt: LATER });
    expect(message.isProcessed()).toBe(true);
    expect(message.toState()).toEqual({ ...base, processedAt: LATER });
  });
});
