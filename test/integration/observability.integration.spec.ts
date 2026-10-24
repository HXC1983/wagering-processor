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

async function scrape(): Promise<string> {
  return (await fetch(`${base}/metrics`)).text();
}

/** Valor de uma série (0 se ainda não existir). `series` inclui os rótulos, ex.: foo_total{a="b"}. */
function metric(text: string, series: string): number {
  const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} (\\S+)$`, 'm').exec(text);
  return match ? Number(match[1]) : 0;
}

interface Fixture {
  walletId: string;
  playerId: string;
}

async function createWallet(balance = '1000.00'): Promise<Fixture> {
  const playerId = randomUUID();
  const response = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return { walletId: body.id, playerId };
}

function bet(fixture: Fixture, externalId: string, amount: string, correlationId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'Idempotency-Key': `provider-obs:${externalId}`,
  };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }
  return fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providerId: 'provider-obs',
      externalTransactionId: externalId,
      playerId: fixture.playerId,
      walletId: fixture.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
}

describe('X-Correlation-Id', () => {
  test('é gerado quando ausente', async () => {
    const response = await fetch(`${base}/health/live`);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('é reaproveitado quando o cliente envia um valor válido', async () => {
    const response = await fetch(`${base}/health/live`, { headers: { 'x-correlation-id': 'meu-id-123' } });
    expect(response.headers.get('x-correlation-id')).toBe('meu-id-123');
  });

  test('um valor inválido é substituído por um novo', async () => {
    const response = await fetch(`${base}/health/live`, { headers: { 'x-correlation-id': 'com espaço' } });
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('atravessa a requisição e chega ao evento da outbox', async () => {
    const fixture = await createWallet();
    const correlationId = `corr-${randomUUID()}`;
    const response = await bet(fixture, `corr-${randomUUID()}`, '10.00', correlationId);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);

    const rows = await query<{ correlation: string }>(
      db.orm,
      "select payload->>'correlationId' as correlation from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionProcessed'",
      [fixture.walletId],
    );
    expect(rows).toEqual([{ correlation: correlationId }]);
  });
});

describe('GET /metrics', () => {
  test('as séries exigidas aparecem desde o início', async () => {
    const text = await scrape();
    for (const name of [
      '# TYPE duplicates_detected_total counter',
      'retries_total{component="outbox_publish"}',
      'dlq_messages_total{reason="permanent"}',
      'lock_conflicts_total{kind="wallet_wait"}',
      'reconciliation_divergences_total',
    ]) {
      expect(text).toContain(name);
    }
  });

  test('a defasagem da outbox é exposta como indicador (valores lidos na hora da consulta)', async () => {
    const text = await scrape();
    expect(text).toMatch(/^outbox_pending_messages \d+$/m);
    expect(text).toMatch(/^outbox_oldest_pending_age_seconds \d+\.\d{3}$/m);
  });

  test('transações por status e latência acompanham o tráfego', async () => {
    const fixture = await createWallet('100.00');
    const processed = 'wager_transactions_total{status="PROCESSED",kind="BET"}';
    const rejected = 'wager_transactions_total{status="REJECTED",kind="BET"}';
    const latency = 'transaction_processing_ms_count{outcome="ok"}';
    const before = await scrape();

    expect((await bet(fixture, `p-${randomUUID()}`, '10.00')).status).toBe(201);
    expect((await bet(fixture, `r-${randomUUID()}`, '5000.00')).status).toBe(422);

    const after = await scrape();
    expect(metric(after, processed)).toBe(metric(before, processed) + 1);
    expect(metric(after, rejected)).toBe(metric(before, rejected) + 1);
    expect(metric(after, latency)).toBe(metric(before, latency) + 2);
  });

  test('payload inválido conta na latência com outcome=error', async () => {
    const fixture = await createWallet('100.00');
    const series = 'transaction_processing_ms_count{outcome="error"}';
    const before = await scrape();
    expect((await bet(fixture, `bad-${randomUUID()}`, '10')).status).toBe(400);
    expect(metric(await scrape(), series)).toBe(metric(before, series) + 1);
  });

  test('duplicata detectada: o replay aumenta o contador e não duplica a transação', async () => {
    const fixture = await createWallet('100.00');
    const series = 'duplicates_detected_total{source="idempotency_key"}';
    const processed = 'wager_transactions_total{status="PROCESSED",kind="BET"}';
    const externalId = `dup-${randomUUID()}`;
    const before = await scrape();

    expect((await bet(fixture, externalId, '10.00')).status).toBe(201);
    expect((await bet(fixture, externalId, '10.00')).status).toBe(200);
    expect((await bet(fixture, externalId, '10.00')).status).toBe(200);

    const after = await scrape();
    expect(metric(after, series)).toBe(metric(before, series) + 2);
    expect(metric(after, processed)).toBe(metric(before, processed) + 1);
  });

  test('conflitos de lock: apostas simultâneas na mesma carteira esperam pela trava', async () => {
    const fixture = await createWallet('1000.00');
    const conflicts = 'lock_conflicts_total{kind="wallet_wait"}';
    const waits = 'wallet_lock_wait_ms_count';
    const before = await scrape();

    const replies = await Promise.all(
      Array.from({ length: 40 }, (_, i) => bet(fixture, `hot-${i}-${randomUUID()}`, '1.00')),
    );
    expect(replies.every((r) => r.status === 201)).toBe(true);

    const after = await scrape();
    expect(metric(after, waits)).toBe(metric(before, waits) + 40);
    expect(metric(after, conflicts)).toBeGreaterThanOrEqual(metric(before, conflicts) + 1);
  }, 60_000);
});
