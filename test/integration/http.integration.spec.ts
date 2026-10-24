import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.factory';
import { migrateToLatest } from '../helpers/app-instance';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  await migrateToLatest();
  app = await createApp(false);
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await app.close();
});

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Reply['body'] };
}

interface Fixture {
  walletId: string;
  playerId: string;
}

async function createWallet(balance = '100.00'): Promise<Fixture> {
  const playerId = randomUUID();
  const reply = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  expect(reply.status).toBe(201);
  return { walletId: reply.body.id, playerId };
}

function betBody(fixture: Fixture, externalId: string, amount: string, kind = 'BET') {
  return {
    providerId: 'provider-http',
    externalTransactionId: externalId,
    playerId: fixture.playerId,
    walletId: fixture.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

const submit = (
  fixture: Fixture,
  externalId: string,
  amount: string,
  options: { kind?: string; key?: string | null } = {},
): Promise<Reply> => {
  const headers: Record<string, string> = {};
  const key = options.key === undefined ? `provider-http:${externalId}` : options.key;
  if (key !== null) {
    headers['Idempotency-Key'] = key;
  }
  return call('POST', '/wagering/transactions', betBody(fixture, externalId, amount, options.kind), headers);
};

describe('POST /wallets e GET /wallets/:id', () => {
  test('cria a wallet (201) e consulta (200)', async () => {
    const playerId = randomUUID();
    const created = await call('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(created.status).toBe(201);
    expect(created.body.playerId).toBe(playerId);
    expect(created.body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(created.body.version).toBe(1);

    const fetched = await call('GET', `/wallets/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);
  });

  test('wallet duplicada para o mesmo jogador e moeda é 409', async () => {
    const playerId = randomUUID();
    const body = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };
    expect((await call('POST', '/wallets', body)).status).toBe(201);
    const duplicate = await call('POST', '/wallets', body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('wallet inexistente é 404, id malformado é 400', async () => {
    const missing = await call('GET', `/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
    expect((await call('GET', '/wallets/nao-e-uuid')).status).toBe(400);
  });

  test('dinheiro malformado ou como number é 400', async () => {
    const playerId = randomUUID();
    const badString = await call('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '10', currency: 'BRL' },
    });
    expect(badString.status).toBe(400);
    expect(badString.body.error.code).toBe('INVALID_MONEY');

    const asNumber = await call('POST', '/wallets', {
      playerId,
      initialBalance: { amount: 10.5, currency: 'BRL' },
    });
    expect(asNumber.status).toBe(400);
    expect(asNumber.body.error.code).toBe('INVALID_REQUEST');
  });
});

describe('POST /wagering/transactions', () => {
  test('primeira vez 201, replay 200, mesma key com payload diferente 409', async () => {
    const fixture = await createWallet('1000.00');
    const ext = `bet-${randomUUID()}`;

    const first = await submit(fixture, ext, '25.00');
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('PROCESSED');
    expect(first.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(first.body.idempotentReplay).toBe(false);

    const replay = await submit(fixture, ext, '25.00');
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);

    const conflict = await submit(fixture, ext, '30.00');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    expect((await call('GET', `/wallets/${fixture.walletId}`)).body.balance.amount).toBe('975.00');
  });

  test('sem o header Idempotency-Key é 400', async () => {
    const fixture = await createWallet();
    const reply = await submit(fixture, `nokey-${randomUUID()}`, '10.00', { key: null });
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('INVALID_REQUEST');
  });

  test('payload inválido é 400', async () => {
    const fixture = await createWallet();
    const reply = await submit(fixture, `bad-${randomUUID()}`, '10');
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('INVALID_MONEY');
  });

  test('rejeição de negócio é 422 com failureCode', async () => {
    const fixture = await createWallet('10.00');
    const reply = await submit(fixture, `rej-${randomUUID()}`, '80.00');
    expect(reply.status).toBe(422);
    expect(reply.body.status).toBe('REJECTED');
    expect(reply.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(reply.body.balance.amount).toBe('10.00');
  });

  test('wallet inexistente é 404 e REFUND sem referência fica pendente (202)', async () => {
    const ghost = { walletId: randomUUID(), playerId: randomUUID() };
    const missing = await submit(ghost, `ghost-${randomUUID()}`, '10.00');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');

    const fixture = await createWallet();
    const refund = await call(
      'POST',
      '/wagering/transactions',
      { ...betBody(fixture, `refund-${randomUUID()}`, '10.00', 'REFUND'), referenceExternalTransactionId: 'x' },
      { 'Idempotency-Key': `k-${randomUUID()}` },
    );
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
  });
});

describe('consulta de transações', () => {
  test('por id e por provedor + id externo', async () => {
    const fixture = await createWallet();
    const ext = `q-${randomUUID()}`;
    const created = await submit(fixture, ext, '20.00');

    const byId = await call('GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.status).toBe('PROCESSED');
    expect(byId.body.money).toEqual({ amount: '20.00', currency: 'BRL' });

    const byExternal = await call('GET', `/providers/provider-http/wagering/transactions/${ext}`);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.id).toBe(created.body.transactionId);
  });

  test('transação inexistente é 404', async () => {
    const reply = await call('GET', `/wagering/transactions/${randomUUID()}`);
    expect(reply.status).toBe(404);
    expect(reply.body.error.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

describe('concorrência via HTTP', () => {
  test('cenário obrigatório: duas apostas simultâneas de 80.00 sobre 100.00', async () => {
    const fixture = await createWallet('100.00');
    const [a, b] = await Promise.all([
      submit(fixture, `race-a-${randomUUID()}`, '80.00'),
      submit(fixture, `race-b-${randomUUID()}`, '80.00'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect((await call('GET', `/wallets/${fixture.walletId}`)).body.balance.amount).toBe('20.00');
  }, 30_000);

  test('a mesma aposta 50 vezes em paralelo: um 201 e 49 replays (200)', async () => {
    const fixture = await createWallet('100.00');
    const ext = `dup-${randomUUID()}`;
    const replies = await Promise.all(Array.from({ length: 50 }, () => submit(fixture, ext, '25.00')));

    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(replies.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await call('GET', `/wallets/${fixture.walletId}`)).body.balance.amount).toBe('75.00');
  }, 30_000);
});
