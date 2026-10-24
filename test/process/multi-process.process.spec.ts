import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AppInstance, createInstance, migrateToLatest, query } from '../helpers/app-instance';
import { AppProcess, startApp } from '../helpers/app-process';
import { waitFor } from '../helpers/wait';

const PROVIDER = 'provider-proc';
let db: AppInstance;
const apps: AppProcess[] = [];
const pick = (n: number): AppProcess => apps[n % apps.length];

beforeAll(async () => {
  await migrateToLatest();
  db = await createInstance();
  apps.push(...(await Promise.all([startApp(), startApp(), startApp()])));
}, 120_000);

afterAll(async () => {
  await Promise.all(apps.map((app) => app.stop()));
  await db.close();
}, 60_000);

interface Fixture {
  walletId: string;
  playerId: string;
}

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
}

async function createWallet(app: AppProcess, balance = '100.00'): Promise<Fixture> {
  const playerId = randomUUID();
  const response = await fetch(`${app.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return { walletId: body.id, playerId };
}

async function bet(app: AppProcess, fixture: Fixture, externalId: string, amount: string): Promise<Reply> {
  const response = await fetch(`${app.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `${PROVIDER}:${externalId}` },
    body: JSON.stringify({
      providerId: PROVIDER,
      externalTransactionId: externalId,
      playerId: fixture.playerId,
      walletId: fixture.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
  return { status: response.status, body: (await response.json()) as Reply['body'] };
}

// ---------- consultas ao banco

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await query<{ n: number }>(db.orm, sql, params);
  return row.n;
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await query<{ balance: string }>(db.orm, 'select balance::text as balance from wallets where id = ?', [
    walletId,
  ]);
  return row.balance;
}

const debitCount = (walletId: string): Promise<number> =>
  scalar("select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

const betCount = (walletId: string): Promise<number> =>
  scalar("select count(*)::int as n from wager_transactions where wallet_id = ? and kind = 'BET'", [walletId]);

const outboxTotal = (walletId: string): Promise<number> =>
  scalar('select count(*)::int as n from outbox_messages where aggregate_id = ?', [walletId]);

const outboxPending = (walletIds: string[]): Promise<number> =>
  scalar(
    `select count(*)::int as n from outbox_messages where published_at is null and aggregate_id in (${walletIds
      .map(() => '?')
      .join(',')})`,
    walletIds,
  );

/** Invariante final: saldo guardado == saldo reconstruído pelo ledger. */
async function expectLedgerInvariant(walletId: string): Promise<void> {
  const [row] = await query<{ stored: string; calculated: string }>(
    db.orm,
    `select w.balance::text as stored,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as calculated
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  expect(row.calculated).toBe(row.stored);
}

/** Banco de testes: o histórico antigo da outbox é dado como publicado, para o publicador só tratar o que importa. */
async function fastForwardOutbox(): Promise<void> {
  await query(db.orm, 'update outbox_messages set published_at = now() where published_at is null');
}

const numerically = (a: number, b: number): number => a - b;

describe('3 processos de verdade contra o mesmo banco', () => {
  test('cenário obrigatório: 100.00 e duas apostas simultâneas de 80.00 vindas de processos diferentes', async () => {
    const rounds = Array.from({ length: 15 }, async (_, i) => {
      const fixture = await createWallet(pick(i));
      const [a, b] = await Promise.all([
        bet(pick(i), fixture, `a-${randomUUID()}`, '80.00'),
        bet(pick(i + 1), fixture, `b-${randomUUID()}`, '80.00'),
      ]);
      return { fixture, statuses: [a.status, b.status].sort(numerically) };
    });

    for (const { fixture, statuses } of await Promise.all(rounds)) {
      expect(statuses).toEqual([201, 422]);
      expect(await balanceOf(fixture.walletId)).toBe('20.00');
      expect(await debitCount(fixture.walletId)).toBe(1);
      await expectLedgerInvariant(fixture.walletId);
    }
  }, 120_000);

  test('a mesma aposta enviada 50 vezes, distribuída entre os 3 processos: um único débito', async () => {
    const fixture = await createWallet(pick(0));
    const externalId = `dup-${randomUUID()}`;

    const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => bet(pick(i), fixture, externalId, '25.00')));

    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(replies.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await balanceOf(fixture.walletId)).toBe('75.00');
    expect(await debitCount(fixture.walletId)).toBe(1);
    await expectLedgerInvariant(fixture.walletId);
  }, 120_000);

  test('carteira quente: 60 apostas de 5.00 sobre 100.00, vindas dos 3 processos, nunca estouram o saldo', async () => {
    const fixture = await createWallet(pick(0));

    const replies = await Promise.all(
      Array.from({ length: 60 }, (_, i) => bet(pick(i), fixture, `hot-${i}-${randomUUID()}`, '5.00')),
    );

    expect(replies.filter((r) => r.status === 201)).toHaveLength(20);
    expect(replies.filter((r) => r.status === 422)).toHaveLength(40);
    expect(await balanceOf(fixture.walletId)).toBe('0.00');
    expect(await debitCount(fixture.walletId)).toBe(20);
    await expectLedgerInvariant(fixture.walletId);
  }, 120_000);
});

describe('queda e reinício', () => {
  test('kill -9 no meio de uma rajada e reinício: cada aposta é aplicada exatamente uma vez', async () => {
    const A = await startApp(); // sem workers: o foco aqui é o saldo
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(A, '1000.00')));
    const plan = wallets.flatMap((fixture) =>
      Array.from({ length: 40 }, (_, i) => ({ fixture, externalId: `kill-${fixture.walletId}-${i}` })),
    );

    // Primeira onda: 200 apostas em andamento; o processo é morto depois da 15ª resposta.
    let completed = 0;
    let killed = false;
    const firstWave = await Promise.all(
      plan.map(async ({ fixture, externalId }) => {
        try {
          return (await bet(A, fixture, externalId, '10.00')).status;
        } catch {
          return 0; // conexão derrubada pelo kill -9
        } finally {
          completed += 1;
          if (!killed && completed >= 15) {
            killed = true;
            void A.kill9();
          }
        }
      }),
    );
    await A.exited();
    const interrupted = firstWave.filter((status) => status === 0).length;
    console.log(JSON.stringify({ test: 'kill-9', total: plan.length, interrompidas: interrupted }));

    // Reinício: outro processo sobe, com o publicador da outbox ligado.
    await fastForwardOutbox();
    const B = await startApp({ outbox: true });
    try {
      // O provedor reenvia TUDO, com as mesmas chaves, sem saber o que chegou a ser gravado.
      const secondWave = await Promise.all(plan.map(({ fixture, externalId }) => bet(B, fixture, externalId, '10.00')));
      for (const reply of secondWave) {
        expect([200, 201]).toContain(reply.status);
      }

      for (const { walletId } of wallets) {
        expect(await balanceOf(walletId)).toBe('600.00'); // 1000 - 40 x 10, nem mais nem menos
        expect(await betCount(walletId)).toBe(40);
        expect(await debitCount(walletId)).toBe(40);
        await expectLedgerInvariant(walletId);
      }

      // Todos os eventos acabam publicados, sem perda: abertura + (Processed e BalanceChanged) por aposta.
      const ids = wallets.map((w) => w.walletId);
      await waitFor(async () => (await outboxPending(ids)) === 0, 90_000, 'outbox publicada após o reinício');
      for (const { walletId } of wallets) {
        expect(await outboxTotal(walletId)).toBe(1 + 2 * 40);
      }
    } finally {
      await B.stop();
    }
  }, 240_000);

  test('processo morre depois do commit e antes de publicar: outra instância publica os eventos', async () => {
    const A = await startApp(); // publicador desligado: os eventos ficam pendentes
    const fixture = await createWallet(A, '100.00');
    for (let i = 0; i < 5; i += 1) {
      expect((await bet(A, fixture, `pre-${i}-${randomUUID()}`, '5.00')).status).toBe(201);
    }
    expect(await outboxPending([fixture.walletId])).toBe(1 + 2 * 5);

    await A.kill9(); // o commit já aconteceu; ninguém publicou nada

    expect(await outboxPending([fixture.walletId])).toBe(1 + 2 * 5); // os eventos sobreviveram à morte
    await fastForwardOutbox();
    // Os eventos desta carteira foram marcados junto; desfaz só para ela e deixa o novo processo publicá-los.
    await query(db.orm, 'update outbox_messages set published_at = null where aggregate_id = ?', [fixture.walletId]);

    const B = await startApp({ outbox: true });
    try {
      await waitFor(async () => (await outboxPending([fixture.walletId])) === 0, 60_000, 'eventos publicados por outra instância');
      expect(await outboxTotal(fixture.walletId)).toBe(1 + 2 * 5); // nenhum perdido, nenhum duplicado
      expect(await balanceOf(fixture.walletId)).toBe('75.00');
      await expectLedgerInvariant(fixture.walletId);
    } finally {
      await B.stop();
    }
  }, 180_000);

  test('SIGTERM com todos os workers ligados: o serviço encerra sozinho dentro do prazo', async () => {
    const app = await startApp({ outbox: true, consumer: true, pendingReference: true });
    const fixture = await createWallet(app, '100.00');
    expect((await bet(app, fixture, `term-${randomUUID()}`, '10.00')).status).toBe(201);

    const result = await app.terminate(20_000);
    console.log(JSON.stringify({ test: 'sigterm', encerrouEmMs: result.elapsedMs }));
    expect(result.exited).toBe(true);
    expect(result.elapsedMs).toBeLessThan(20_000);

    // A aposta feita antes do encerramento continua consistente.
    expect(await balanceOf(fixture.walletId)).toBe('90.00');
    await expectLedgerInvariant(fixture.walletId);
  }, 90_000);
});
