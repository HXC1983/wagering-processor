import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.factory';
import { AppInstance, createInstance, migrateToLatest, query } from '../helpers/app-instance';

let app: INestApplication;
let db: AppInstance;
let base: string;

beforeAll(async () => {
  await migrateToLatest();
  app = await createApp(false);
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  db = await createInstance();
}, 30_000);

afterAll(async () => {
  await Promise.all([app.close(), db.close()]);
});

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Reply['body'], headers: response.headers };
}

interface Fixture {
  walletId: string;
  playerId: string;
}

async function createWallet(balance = '1000.00'): Promise<Fixture> {
  const playerId = randomUUID();
  const reply = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  expect(reply.status).toBe(201);
  return { walletId: reply.body.id, playerId };
}

async function bet(fixture: Fixture, amount: string): Promise<Reply> {
  const externalId = `led-${randomUUID()}`;
  return call(
    'POST',
    '/wagering/transactions',
    {
      providerId: 'provider-ledger',
      externalTransactionId: externalId,
      playerId: fixture.playerId,
      walletId: fixture.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
    { 'Idempotency-Key': `provider-ledger:${externalId}` },
  );
}

describe('GET /health/ready e GET /metrics', () => {
  test('ready responde 200 com PostgreSQL e SQS no ar', async () => {
    const reply = await call('GET', '/health/ready');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: 'ready', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('live continua respondendo ok', async () => {
    const reply = await call('GET', '/health/live');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: 'ok' });
  });

  test('metrics expõe o contador de divergências em texto', async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('# TYPE reconciliation_divergences_total counter');
    expect(text).toMatch(/^reconciliation_divergences_total \d+$/m);
  });
});

describe('GET /wallets/:id/ledger', () => {
  test('pagina por cursor, sem repetir nem pular, mesmo com novos lançamentos no meio', async () => {
    const fixture = await createWallet('1000.00');
    for (let i = 0; i < 7; i += 1) {
      expect((await bet(fixture, '10.00')).status).toBe(201);
    }

    const first = await call('GET', `/wallets/${fixture.walletId}/ledger?limit=3`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(3);
    expect(typeof first.body.nextCursor).toBe('string');

    // Um novo lançamento chega entre uma página e outra.
    expect((await bet(fixture, '10.00')).status).toBe(201);

    const collected = [...first.body.items];
    let cursor: string | null = first.body.nextCursor;
    while (cursor) {
      const page = await call('GET', `/wallets/${fixture.walletId}/ledger?limit=3&cursor=${encodeURIComponent(cursor)}`);
      expect(page.status).toBe(200);
      collected.push(...page.body.items);
      cursor = page.body.nextCursor;
    }

    expect(collected).toHaveLength(9); // abertura + 8 apostas
    expect(new Set(collected.map((item) => item.id)).size).toBe(9);
    expect(collected[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });
    expect(collected[8].balanceAfter.amount).toBe('920.00');
    for (let i = 1; i < collected.length; i += 1) {
      expect(collected[i].balanceBefore.amount).toBe(collected[i - 1].balanceAfter.amount);
    }
    expect(collected.every((item) => !('seq' in item))).toBe(true);
  }, 60_000);

  test('sem parâmetros usa o limite padrão e devolve tudo em uma página', async () => {
    const fixture = await createWallet('100.00');
    await bet(fixture, '10.00');
    const reply = await call('GET', `/wallets/${fixture.walletId}/ledger`);
    expect(reply.status).toBe(200);
    expect(reply.body.items).toHaveLength(2);
    expect(reply.body.nextCursor).toBeNull();
  });

  test.each(['limit=0', 'limit=201', 'limit=abc', 'limit=-1', 'limit=2.5'])('limit inválido (%s) é 400', async (param) => {
    const fixture = await createWallet('100.00');
    const reply = await call('GET', `/wallets/${fixture.walletId}/ledger?${param}`);
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('INVALID_REQUEST');
  });

  test('cursor inválido é 400 e carteira inexistente é 404', async () => {
    const fixture = await createWallet('100.00');
    const badCursor = await call('GET', `/wallets/${fixture.walletId}/ledger?cursor=lixo`);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe('INVALID_CURSOR');

    const missing = await call('GET', `/wallets/${randomUUID()}/ledger`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  test('carteira íntegra: consistente, com a diferença zerada', async () => {
    const fixture = await createWallet('100.00');
    await bet(fixture, '25.00');
    await bet(fixture, '10.00');

    const reply = await call('POST', `/wallets/${fixture.walletId}/reconciliation`);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      walletId: fixture.walletId,
      storedBalance: { amount: '65.00', currency: 'BRL' },
      calculatedBalance: { amount: '65.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('divergência: sinalizada e contada, e o saldo NÃO é corrigido em silêncio', async () => {
    const fixture = await createWallet('100.00');
    await bet(fixture, '25.00'); // ledger diz 75.00

    // Corrompe o saldo guardado diretamente no banco (o ledger é protegido; o saldo, não).
    await query(db.orm, "update wallets set balance = '999.00' where id = ?", [fixture.walletId]);

    const before = await (await fetch(`${base}/metrics`)).text();
    const countBefore = Number(/^reconciliation_divergences_total (\d+)$/m.exec(before)?.[1]);

    const reply = await call('POST', `/wallets/${fixture.walletId}/reconciliation`);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      storedBalance: { amount: '999.00' },
      calculatedBalance: { amount: '75.00' },
      difference: { amount: '924.00' },
      consistent: false,
      checkedEntries: 2,
    });

    // O saldo continua errado: nada foi corrigido.
    expect((await call('GET', `/wallets/${fixture.walletId}`)).body.balance.amount).toBe('999.00');

    const after = await (await fetch(`${base}/metrics`)).text();
    const countAfter = Number(/^reconciliation_divergences_total (\d+)$/m.exec(after)?.[1]);
    expect(countAfter).toBe(countBefore + 1);
  });

  test('carteira inexistente é 404 e id malformado é 400', async () => {
    expect((await call('POST', `/wallets/${randomUUID()}/reconciliation`)).status).toBe(404);
    expect((await call('POST', '/wallets/nao-e-uuid/reconciliation')).status).toBe(400);
  });
});
