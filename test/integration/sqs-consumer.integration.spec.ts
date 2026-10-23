import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SqsConsumer, SqsConsumerOptions } from '../../src/infrastructure/messaging/sqs-consumer';
import { createSqsClient, queueUrlFor, sqsSettings } from '../../src/infrastructure/messaging/sqs.config';
import { HandleOutcome, MessageHandler, WagerMessageHandler } from '../../src/wagering/application/wager-message-handler';
import { AppInstance, createInstance, migrateToLatest, query } from '../helpers/app-instance';

const settings = sqsSettings();
let sqs: SQSClient;
let a: AppInstance;
let b: AppInstance;
let handlerA: WagerMessageHandler;
let handlerB: WagerMessageHandler;

beforeAll(async () => {
  await migrateToLatest();
  sqs = createSqsClient();
  a = await createInstance();
  b = await createInstance();
  handlerA = new WagerMessageHandler(a.processTransaction);
  handlerB = new WagerMessageHandler(b.processTransaction);
}, 30_000);

afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
  sqs.destroy();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error('timeout aguardando a condição');
}

// ---------- fixtures de banco

interface Fixture {
  walletId: string;
  playerId: string;
}

async function newWallet(balance = '100.00'): Promise<Fixture> {
  const playerId = randomUUID();
  const wallet = await a.openWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  return { walletId: wallet.id, playerId };
}

function wagerMessage(
  fixture: Fixture,
  options: { messageId?: string; externalId?: string; amount?: string; kind?: string } = {},
): string {
  const externalId = options.externalId ?? `ext-${randomUUID()}`;
  return JSON.stringify({
    messageId: options.messageId ?? `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-sqs',
      externalTransactionId: externalId,
      idempotencyKey: `provider-sqs:${externalId}`,
      playerId: fixture.playerId,
      walletId: fixture.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: options.kind ?? 'BET',
      money: { amount: options.amount ?? '30.00', currency: 'BRL' },
    },
  });
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await query<{ balance: string }>(
    a.orm,
    'select balance::text as balance from wallets where id = ?',
    [walletId],
  );
  return row.balance;
}

async function debitCount(walletId: string): Promise<number> {
  const [row] = await query<{ n: number }>(
    a.orm,
    "select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
    [walletId],
  );
  return row.n;
}

async function inboxCount(messageId: string): Promise<number> {
  const [row] = await query<{ n: number }>(
    a.orm,
    'select count(*)::int as n from inbox_messages where message_id = ? and processed_at is not null',
    [messageId],
  );
  return row.n;
}

// ---------- fixtures de fila

interface QueuePair {
  main: string;
  dlq: string;
}

async function createQueuePair(visibilitySeconds = 2): Promise<QueuePair> {
  const suffix = randomUUID();
  const dlqName = `tx-dlq-${suffix}.fifo`;
  const mainName = `tx-${suffix}.fifo`;
  await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }));
  await sqs.send(
    new CreateQueueCommand({
      QueueName: mainName,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(visibilitySeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: `arn:aws:sqs:${settings.region}:${settings.accountId}:${dlqName}`,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
  return { main: queueUrlFor(settings, mainName), dlq: queueUrlFor(settings, dlqName) };
}

async function deletePair(pair: QueuePair): Promise<void> {
  await Promise.all([
    sqs.send(new DeleteQueueCommand({ QueueUrl: pair.main })),
    sqs.send(new DeleteQueueCommand({ QueueUrl: pair.dlq })),
  ]);
}

async function send(queueUrl: string, body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(), // dedup do broker de propósito desligada: o inbox é que protege
    }),
  );
}

async function receiveOne(queueUrl: string, visibilitySeconds = 10, waitMs = 15_000): Promise<Message | undefined> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: visibilitySeconds,
        MessageAttributeNames: ['All'],
      }),
    );
    if (out.Messages?.length) return out.Messages[0];
  }
  return undefined;
}

async function queueIsDrained(queueUrl: string): Promise<boolean> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  return Object.values(out.Attributes ?? {}).every((value) => value === '0');
}

function consumerFor(
  handler: MessageHandler,
  pair: QueuePair,
  overrides: Partial<SqsConsumerOptions> = {},
): SqsConsumer {
  return new SqsConsumer(sqs, handler, { queueUrl: pair.main, dlqUrl: pair.dlq, waitSeconds: 1, ...overrides });
}

// ---------- handler + banco real (sem fila)

describe('mensagem -> caso de uso -> banco (inbox na mesma transação)', () => {
  test('processa a mensagem e grava inbox, transação, ledger e outbox juntos', async () => {
    const fixture = await newWallet('100.00');
    const messageId = `msg-${randomUUID()}`;

    const outcome = await handlerA.handle(wagerMessage(fixture, { messageId, amount: '25.00' }));
    expect(outcome).toMatchObject({ kind: 'done', status: 'PROCESSED', replay: false });

    expect(await balanceOf(fixture.walletId)).toBe('75.00');
    expect(await debitCount(fixture.walletId)).toBe(1);
    expect(await inboxCount(messageId)).toBe(1);
  });

  test('redelivery da mesma messageId não debita de novo', async () => {
    const fixture = await newWallet('100.00');
    const body = wagerMessage(fixture, { amount: '25.00' });

    expect(await handlerA.handle(body)).toMatchObject({ kind: 'done', replay: false });
    expect(await handlerB.handle(body)).toMatchObject({ kind: 'done', replay: true });
    expect(await handlerA.handle(body)).toMatchObject({ kind: 'done', replay: true });

    expect(await balanceOf(fixture.walletId)).toBe('75.00');
    expect(await debitCount(fixture.walletId)).toBe(1);
  });

  test('mesma messageId com payload diferente é erro permanente (conflito de inbox)', async () => {
    const fixture = await newWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    await handlerA.handle(wagerMessage(fixture, { messageId, amount: '25.00' }));

    const outcome = await handlerA.handle(wagerMessage(fixture, { messageId, amount: '40.00' }));
    expect(outcome).toMatchObject({ kind: 'permanent', code: 'INBOX_CONFLICT' });
    expect(await balanceOf(fixture.walletId)).toBe('75.00');
  });

  test('mensagem nova com a mesma chave de idempotência é replay e também entra no inbox', async () => {
    const fixture = await newWallet('100.00');
    const externalId = `ext-${randomUUID()}`;
    const first = wagerMessage(fixture, { externalId, amount: '25.00' });
    const second = wagerMessage(fixture, { externalId, amount: '25.00' }); // outra messageId

    expect(await handlerA.handle(first)).toMatchObject({ kind: 'done', replay: false });
    expect(await handlerB.handle(second)).toMatchObject({ kind: 'done', replay: true });

    expect(await balanceOf(fixture.walletId)).toBe('75.00');
    expect(await debitCount(fixture.walletId)).toBe(1);
    expect(await inboxCount(JSON.parse(second).messageId)).toBe(1);
  });

  test('saldo insuficiente é um resultado de negócio: processada como rejeitada, com ack', async () => {
    const fixture = await newWallet('10.00');
    const outcome = await handlerA.handle(wagerMessage(fixture, { amount: '80.00' }));
    expect(outcome).toMatchObject({ kind: 'done', status: 'REJECTED', replay: false });
    expect(await balanceOf(fixture.walletId)).toBe('10.00');
  });

  test('carteira inexistente e mensagem malformada são permanentes', async () => {
    const ghost = { walletId: randomUUID(), playerId: randomUUID() };
    expect(await handlerA.handle(wagerMessage(ghost))).toMatchObject({
      kind: 'permanent',
      code: 'WALLET_NOT_FOUND',
    });
    expect(await handlerA.handle('isto não é json')).toMatchObject({ kind: 'permanent' });
  });
});

// ---------- fila real (LocalStack)

describe('consumidor SQS real', () => {
  test('duas instâncias consomem a mesma fila com mensagens duplicadas: um débito por mensagem', async () => {
    const pair = await createQueuePair(5);
    const consumers = [consumerFor(handlerA, pair), consumerFor(handlerB, pair)];
    try {
      const fixtures = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));
      const bodies = fixtures.map((fixture) => wagerMessage(fixture, { amount: '30.00' }));
      for (const [i, body] of bodies.entries()) {
        await send(pair.main, body, fixtures[i].walletId);
        await send(pair.main, body, fixtures[i].walletId); // a mesma mensagem entregue duas vezes
      }

      consumers.forEach((consumer) => consumer.start());
      await waitFor(() => queueIsDrained(pair.main));

      for (const [i, fixture] of fixtures.entries()) {
        expect(await balanceOf(fixture.walletId)).toBe('70.00');
        expect(await debitCount(fixture.walletId)).toBe(1);
        expect(await inboxCount(JSON.parse(bodies[i]).messageId)).toBe(1);
      }
      expect(await queueIsDrained(pair.dlq)).toBe(true);
    } finally {
      await Promise.all(consumers.map((consumer) => consumer.stop()));
      await deletePair(pair);
    }
  }, 90_000);

  test('worker morto depois do commit e antes do ack: a mensagem volta e é reconhecida como duplicada', async () => {
    const pair = await createQueuePair(2);
    try {
      const fixture = await newWallet('100.00');
      await send(pair.main, wagerMessage(fixture, { amount: '25.00' }), fixture.walletId);

      // O "worker" recebe, processa (commit) e morre antes do DeleteMessage.
      const first = await receiveOne(pair.main, 1);
      expect(first).toBeDefined();
      expect(await handlerA.handle(first?.Body ?? '')).toMatchObject({ kind: 'done', replay: false });
      expect(await balanceOf(fixture.walletId)).toBe('75.00');

      await sleep(1_500); // a visibilidade expira

      // Outra instância recebe a mesma mensagem de novo.
      const second = await receiveOne(pair.main, 10);
      expect(second?.MessageId).toBe(first?.MessageId);
      expect(await handlerB.handle(second?.Body ?? '')).toMatchObject({ kind: 'done', replay: true });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: pair.main, ReceiptHandle: second?.ReceiptHandle }));

      expect(await balanceOf(fixture.walletId)).toBe('75.00');
      expect(await debitCount(fixture.walletId)).toBe(1);
    } finally {
      await deletePair(pair);
    }
  }, 60_000);

  test('mensagem permanente vai direto para a DLQ e sai da fila principal', async () => {
    const pair = await createQueuePair(5);
    const consumer = consumerFor(handlerA, pair);
    try {
      await send(pair.main, 'isto não é json', 'grupo-invalido');
      consumer.start();

      const inDlq = await receiveOne(pair.dlq, 5, 20_000);
      expect(inDlq?.Body).toBe('isto não é json');
      expect(inDlq?.MessageAttributes?.failureKind?.StringValue).toBe('permanent');
      await waitFor(() => queueIsDrained(pair.main));
    } finally {
      await consumer.stop();
      await deletePair(pair);
    }
  }, 60_000);

  test('falha transitória: tenta de novo com backoff e vai para a DLQ no limite de recebimentos', async () => {
    const pair = await createQueuePair(5);
    let calls = 0;
    const alwaysTransient: MessageHandler = {
      async handle(): Promise<HandleOutcome> {
        calls += 1;
        return { kind: 'transient', reason: 'banco indisponível' };
      },
    };
    const consumer = consumerFor(alwaysTransient, pair, { maxReceives: 2, backoffBaseSeconds: 1 });
    try {
      await send(pair.main, 'qualquer corpo', 'grupo-transitorio');
      consumer.start();

      const inDlq = await receiveOne(pair.dlq, 5, 25_000);
      expect(inDlq?.MessageAttributes?.failureKind?.StringValue).toBe('retries-exhausted');
      expect(calls).toBe(2); // exatamente o limite: nem antes, nem depois
    } finally {
      await consumer.stop();
      await deletePair(pair);
    }
  }, 60_000);

  test('falha transitória que se resolve: a segunda tentativa processa e apaga a mensagem', async () => {
    const pair = await createQueuePair(5);
    const fixture = await newWallet('100.00');
    let calls = 0;
    const flaky: MessageHandler = {
      async handle(body: string): Promise<HandleOutcome> {
        calls += 1;
        if (calls === 1) {
          return { kind: 'transient', reason: 'timeout de rede' };
        }
        return handlerA.handle(body);
      },
    };
    const consumer = consumerFor(flaky, pair, { backoffBaseSeconds: 1 });
    try {
      await send(pair.main, wagerMessage(fixture, { amount: '25.00' }), fixture.walletId);
      consumer.start();

      await waitFor(async () => (await balanceOf(fixture.walletId)) === '75.00');
      await waitFor(() => queueIsDrained(pair.main));
      expect(calls).toBe(2);
      expect(await debitCount(fixture.walletId)).toBe(1);
      expect(await queueIsDrained(pair.dlq)).toBe(true);
    } finally {
      await consumer.stop();
      await deletePair(pair);
    }
  }, 60_000);

  test('SIGTERM: conclui a mensagem em andamento e devolve as demais do lote', async () => {
    const pair = await createQueuePair(30);
    let started = 0;
    let completed = 0;
    const slow: MessageHandler = {
      async handle(): Promise<HandleOutcome> {
        started += 1;
        await sleep(800);
        completed += 1;
        return { kind: 'done', status: 'PROCESSED', replay: false, transactionId: 't' };
      },
    };
    const consumer = consumerFor(slow, pair);
    try {
      for (let i = 0; i < 3; i += 1) {
        await send(pair.main, `mensagem ${i}`, 'mesmo-grupo');
      }
      consumer.start();
      await waitFor(async () => started >= 1);

      await consumer.stop(); // pedido de encerramento no meio da primeira mensagem

      expect(completed).toBe(1); // a que estava em andamento terminou
      // As outras duas foram devolvidas (visibilidade 0): já estão disponíveis, sem esperar os 30s.
      const out = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: pair.main, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
      );
      expect(out.Messages?.length).toBe(2);
    } finally {
      await deletePair(pair);
    }
  }, 60_000);
});
