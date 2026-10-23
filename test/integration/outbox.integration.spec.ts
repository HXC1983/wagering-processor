import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createSqsClient, queueUrlFor, sqsSettings } from '../../src/infrastructure/messaging/sqs.config';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmOutboxRunner } from '../../src/infrastructure/persistence/mikro-orm-outbox-runner';
import type { EventPublisher } from '../../src/wagering/application/outbox-ports';
import { OutboxRelay } from '../../src/wagering/application/outbox-relay';
import type { OutboxMessage } from '../../src/wagering/domain/outbox-message';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind';
import { AppInstance, createInstance, migrateToLatest, query } from '../helpers/app-instance';

let a: AppInstance;
let b: AppInstance;

class RecordingPublisher implements EventPublisher {
  readonly ids: string[] = [];
  failTimes = 0;

  constructor(private readonly delayMs = 0) {}

  async publish(message: OutboxMessage): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('broker indisponível');
    }
    this.ids.push(message.id);
  }
}

function relayFor(
  instance: AppInstance,
  publisher: EventPublisher,
  options: { batchSize?: number; clock?: () => Date } = {},
): OutboxRelay {
  return new OutboxRelay(new MikroOrmOutboxRunner(instance.orm), publisher, options);
}

/** Esvazia a outbox (inclusive o histórico de testes anteriores) com um publisher que só registra. */
async function drain(instance: AppInstance, publisher: EventPublisher, batchSize = 200): Promise<number> {
  const relay = relayFor(instance, publisher, { batchSize });
  let published = 0;
  for (;;) {
    const result = await relay.runOnce();
    published += result.published;
    if (result.claimed === 0) {
      return published;
    }
  }
}

async function pendingIds(instance: AppInstance): Promise<string[]> {
  const rows = await query<{ id: string }>(
    instance.orm,
    'select id from outbox_messages where published_at is null order by id',
  );
  return rows.map((row) => row.id);
}

/** Cada carteira com uma aposta gera 3 mensagens: abertura (BalanceChanged) + Processed + BalanceChanged. */
async function createBet(instance: AppInstance): Promise<string> {
  const playerId = randomUUID();
  const wallet = await instance.openWallet.execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const externalId = `out-${randomUUID()}`;
  await instance.processTransaction.execute({
    providerId: 'provider-outbox',
    externalTransactionId: externalId,
    idempotencyKey: `provider-outbox:${externalId}`,
    playerId,
    walletId: wallet.id,
    roundId: 'r1',
    gameId: 'g1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  });
  return wallet.id;
}

const sorted = (values: string[]): string[] => [...values].sort();

beforeAll(async () => {
  await migrateToLatest();
  a = await createInstance();
  b = await createInstance();
}, 30_000);

beforeEach(async () => {
  await drain(a, new RecordingPublisher());
}, 120_000);

afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
});

describe('publicação da outbox', () => {
  test('publica as mensagens pendentes e não publica de novo', async () => {
    await Promise.all(Array.from({ length: 5 }, () => createBet(a)));
    const pending = await pendingIds(a);
    expect(pending).toHaveLength(15);

    const publisher = new RecordingPublisher();
    const relay = relayFor(a, publisher, { batchSize: 4 });
    await drain(a, publisher, 4);

    expect(sorted(publisher.ids)).toEqual(sorted(pending));
    expect(await pendingIds(a)).toEqual([]);
    expect((await relay.runOnce()).claimed).toBe(0);
  }, 60_000);

  test('falha de publicação agenda nova tentativa com backoff e depois publica', async () => {
    const walletId = await createBet(a);
    const publisher = new RecordingPublisher();
    publisher.failTimes = 1_000;

    let now = new Date();
    const relay = relayFor(a, publisher, { batchSize: 10, clock: () => now });

    expect(await relay.runOnce()).toEqual({ claimed: 3, published: 0, failed: 3 });

    const rows = await query<{ attempts: number; next_attempt_at: Date | string; published_at: unknown }>(
      a.orm,
      'select attempts, next_attempt_at, published_at from outbox_messages where aggregate_id = ?',
      [walletId],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.attempts).toBe(1);
      expect(row.published_at).toBeNull();
      expect(new Date(row.next_attempt_at).getTime()).toBe(now.getTime() + 1_000);
    }

    // Ainda não venceu: nada é reservado.
    expect((await relay.runOnce()).claimed).toBe(0);

    // O tempo passa e o broker volta.
    now = new Date(now.getTime() + 2_000);
    publisher.failTimes = 0;
    expect(await relay.runOnce()).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(await pendingIds(a)).toEqual([]);
  }, 60_000);

  test('dois publishers concorrentes não publicam a mesma mensagem (SKIP LOCKED)', async () => {
    await Promise.all(Array.from({ length: 20 }, () => createBet(a)));
    const pending = await pendingIds(a);
    expect(pending).toHaveLength(60);

    const publisherA = new RecordingPublisher(10);
    const publisherB = new RecordingPublisher(10);
    await Promise.all([drain(a, publisherA, 5), drain(b, publisherB, 5)]);

    const all = [...publisherA.ids, ...publisherB.ids];
    expect(new Set(all).size).toBe(all.length); // nenhuma mensagem em duplicidade
    expect(sorted(all)).toEqual(sorted(pending)); // nenhuma se perdeu
    expect(publisherA.ids.length).toBeGreaterThan(0);
    expect(publisherB.ids.length).toBeGreaterThan(0);
    expect(await pendingIds(a)).toEqual([]);
  }, 60_000);

  test('mensagens pendentes após uma "queda" são publicadas por outra instância', async () => {
    // A instância A gravou os eventos (commit) e "morreu" antes de publicar: nada foi publicado.
    await createBet(a);
    const pending = await pendingIds(a);
    expect(pending).toHaveLength(3);

    // A instância B, que nunca viu essas mensagens, assume o trabalho.
    const publisher = new RecordingPublisher();
    await drain(b, publisher);
    expect(sorted(publisher.ids)).toEqual(sorted(pending));
  }, 60_000);
});

describe('publicação no SQS real (LocalStack)', () => {
  test('o evento chega à fila FIFO com o envelope íntegro', async () => {
    const sqs = createSqsClient();
    const settings = sqsSettings();
    const queueName = `wager-events-test-${randomUUID()}.fifo`;
    await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true' } }));
    const queueUrl = queueUrlFor(settings, queueName);

    try {
      const walletId = await createBet(a);
      const pending = await pendingIds(a);
      expect(pending).toHaveLength(3);

      const relay = relayFor(a, new SqsEventPublisher(sqs, queueUrl), { batchSize: 10 });
      expect(await relay.runOnce()).toEqual({ claimed: 3, published: 3, failed: 0 });

      interface Envelope {
        eventId: string;
        eventType: string;
        aggregateId: string;
        version: number;
        data: unknown;
      }
      const received = new Map<string, Envelope>();
      const deadline = Date.now() + 20_000;
      while (received.size < 3 && Date.now() < deadline) {
        const out = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
        );
        for (const message of out.Messages ?? []) {
          const envelope = JSON.parse(message.Body ?? '{}') as Envelope;
          received.set(envelope.eventId, envelope);
          // Apagar libera o grupo FIFO para entregar a próxima mensagem.
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        }
      }

      expect(sorted([...received.keys()])).toEqual(sorted(pending));
      for (const envelope of received.values()) {
        expect(envelope.aggregateId).toBe(walletId);
        expect(['WagerTransactionProcessed', 'WalletBalanceChanged']).toContain(envelope.eventType);
        expect(envelope.version).toBe(1);
        expect(envelope.data).toBeDefined();
      }
      expect(await pendingIds(a)).toEqual([]);
    } finally {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      sqs.destroy();
    }
  }, 60_000);
});
