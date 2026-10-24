import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroOrmPendingReferenceReader } from '../../src/infrastructure/persistence/mikro-orm-pending-reference-reader';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/persistence/mikro-orm-transaction-runner';
import type { ProcessWagerTransactionResult } from '../../src/wagering/application/process-wager-transaction.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/wagering/application/reprocess-pending-references.use-case';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { WagerTransactionKind as Kind } from '../../src/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction-status';
import { AppInstance, createInstance, migrateToLatest, query } from '../helpers/app-instance';

const PROVIDER = 'provider-rev';
const instances: AppInstance[] = [];
const pick = (n: number): AppInstance => instances[n % instances.length];

beforeAll(async () => {
  await migrateToLatest();
  for (let i = 0; i < 3; i += 1) {
    instances.push(await createInstance());
  }
}, 30_000);

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.close()));
});

interface Fixture {
  walletId: string;
  playerId: string;
}

async function newWallet(balance = '100.00'): Promise<Fixture> {
  const playerId = randomUUID();
  const wallet = await pick(0).openWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  return { walletId: wallet.id, playerId };
}

const ext = (prefix: string): string => `${prefix}-${randomUUID()}`;

function run(
  fixture: Fixture,
  externalId: string,
  amount: string,
  kind: Kind,
  reference?: string,
  overrides: { roundId?: string; instance?: number } = {},
): Promise<ProcessWagerTransactionResult> {
  return pick(overrides.instance ?? 0).processTransaction.execute({
    providerId: PROVIDER,
    externalTransactionId: externalId,
    idempotencyKey: `${PROVIDER}:${externalId}`,
    playerId: fixture.playerId,
    walletId: fixture.walletId,
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    referenceExternalTransactionId: reference,
  });
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await query<{ balance: string }>(pick(0).orm, 'select balance::text as balance from wallets where id = ?', [walletId]);
  return row.balance;
}

async function ledgerCount(walletId: string, direction: string): Promise<number> {
  const [row] = await query<{ n: number }>(
    pick(0).orm,
    'select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = ?',
    [walletId, direction],
  );
  return row.n;
}

async function outboxCounts(walletId: string): Promise<Record<string, number>> {
  const rows = await query<{ event_type: string; n: number }>(
    pick(0).orm,
    'select event_type, count(*)::int as n from outbox_messages where aggregate_id = ? group by event_type',
    [walletId],
  );
  return Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
}

async function expectLedgerInvariant(walletId: string): Promise<void> {
  const [row] = await query<{ stored: string; calculated: string }>(
    pick(0).orm,
    `select w.balance::text as stored,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as calculated
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  expect(row.calculated).toBe(row.stored);
}

function workerFor(instance: AppInstance, clock: () => Date): ReprocessPendingReferencesUseCase {
  return new ReprocessPendingReferencesUseCase(
    new MikroOrmTransactionRunner(instance.orm),
    new MikroOrmPendingReferenceReader(instance.orm),
    { clock, batchSize: 1_000 },
  );
}

describe('REFUND', () => {
  test('reverte uma BET: credita de volta, gera lançamento e eventos', async () => {
    const f = await newWallet('100.00');
    const bet = ext('bet');
    expect((await run(f, bet, '25.00', Kind.Bet)).balance.amount).toBe('75.00');

    const refundExt = ext('refund');
    const refund = await run(f, refundExt, '25.00', Kind.Refund, bet);
    expect(refund).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    expect(refund.balance.amount).toBe('100.00');
    expect(await balanceOf(f.walletId)).toBe('100.00');
    expect(await ledgerCount(f.walletId, 'DEBIT')).toBe(1);
    expect(await ledgerCount(f.walletId, 'CREDIT')).toBe(2); // abertura + refund
    await expectLedgerInvariant(f.walletId);

    const events = await outboxCounts(f.walletId);
    expect(events.WagerTransactionProcessed).toBe(2);
    expect(events.WalletBalanceChanged).toBe(3);

    // replay devolve o resultado original, sem novo lançamento
    const replay = await run(f, refundExt, '25.00', Kind.Refund, bet);
    expect(replay).toMatchObject({ status: Status.Processed, idempotentReplay: true, transactionId: refund.transactionId });
    expect(await ledgerCount(f.walletId, 'CREDIT')).toBe(2);
  });
});

describe('ROLLBACK', () => {
  test('de uma BET credita, de uma WIN debita, de um REFUND debita', async () => {
    const f = await newWallet('100.00');

    const bet = ext('bet');
    await run(f, bet, '30.00', Kind.Bet); // 70
    const rollbackBet = await run(f, ext('rb-bet'), '30.00', Kind.Rollback, bet);
    expect(rollbackBet.balance.amount).toBe('100.00');

    const win = ext('win');
    await run(f, win, '40.00', Kind.Win); // 140
    const rollbackWin = await run(f, ext('rb-win'), '40.00', Kind.Rollback, win);
    expect(rollbackWin.balance.amount).toBe('100.00');

    const bet2 = ext('bet2');
    await run(f, bet2, '25.00', Kind.Bet); // 75
    const refund = ext('refund');
    await run(f, refund, '25.00', Kind.Refund, bet2); // 100
    const rollbackRefund = await run(f, ext('rb-refund'), '25.00', Kind.Rollback, refund);
    expect(rollbackRefund.balance.amount).toBe('75.00');

    expect(await balanceOf(f.walletId)).toBe('75.00');
    await expectLedgerInvariant(f.walletId);
  });
});

describe('regras de rejeição', () => {
  test('uma referência só é revertida uma vez, por qualquer tipo de reversão', async () => {
    const f = await newWallet('100.00');
    const bet = ext('bet');
    await run(f, bet, '25.00', Kind.Bet);
    await run(f, ext('refund'), '25.00', Kind.Refund, bet);

    const second = await run(f, ext('refund-2'), '25.00', Kind.Refund, bet);
    const rollback = await run(f, ext('rb'), '25.00', Kind.Rollback, bet);
    for (const result of [second, rollback]) {
      expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });
      expect(result.balance.amount).toBe('100.00');
    }
    expect(await balanceOf(f.walletId)).toBe('100.00');
    expect(await ledgerCount(f.walletId, 'CREDIT')).toBe(2); // abertura + um único refund
  });

  test('valor, tipo e contexto inválidos são rejeitados sem alterar nada', async () => {
    const f = await newWallet('100.00');
    const bet = ext('bet');
    const win = ext('win');
    const loss = ext('loss');
    await run(f, bet, '25.00', Kind.Bet);
    await run(f, win, '10.00', Kind.Win);
    await run(f, loss, '5.00', Kind.Loss);
    const before = await balanceOf(f.walletId); // 85.00

    const amount = await run(f, ext('a'), '20.00', Kind.Refund, bet);
    const kindWin = await run(f, ext('b'), '10.00', Kind.Refund, win);
    const kindLoss = await run(f, ext('c'), '5.00', Kind.Rollback, loss);
    const round = await run(f, ext('d'), '25.00', Kind.Refund, bet, { roundId: 'outra-rodada' });

    expect(amount.failureCode).toBe(FailureCode.AmountMismatch);
    expect(kindWin.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    expect(kindLoss.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    expect(round.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(await balanceOf(f.walletId)).toBe(before);
    await expectLedgerInvariant(f.walletId);
  });

  test('reversão que deixaria o saldo negativo é rejeitada com código próprio', async () => {
    const f = await newWallet('100.00');
    const win = ext('win');
    await run(f, win, '50.00', Kind.Win); // 150
    await run(f, ext('bet'), '150.00', Kind.Bet); // 0

    const rollback = await run(f, ext('rb'), '50.00', Kind.Rollback, win);
    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(f.walletId)).toBe('0.00');
    await expectLedgerInvariant(f.walletId);
  });
});

describe('referência fora de ordem', () => {
  test('REFUND antes da BET fica pendente e é aplicado quando a referência chega', async () => {
    const f = await newWallet('100.00');
    const bet = ext('bet');
    const refundExt = ext('refund');

    const pending = await run(f, refundExt, '25.00', Kind.Refund, bet);
    expect(pending).toMatchObject({ status: Status.PendingReference, idempotentReplay: false });
    expect(pending.balance.amount).toBe('100.00');

    const replayPending = await run(f, refundExt, '25.00', Kind.Refund, bet);
    expect(replayPending).toMatchObject({
      status: Status.PendingReference,
      idempotentReplay: true,
      transactionId: pending.transactionId,
    });

    expect((await run(f, bet, '25.00', Kind.Bet)).balance.amount).toBe('75.00');

    const worker = workerFor(pick(0), () => new Date(Date.now() + 61_000));
    expect((await worker.runOnce()).processed).toBeGreaterThanOrEqual(1);

    const final = await run(f, refundExt, '25.00', Kind.Refund, bet);
    expect(final).toMatchObject({ status: Status.Processed, idempotentReplay: true, transactionId: pending.transactionId });
    expect(final.balance.amount).toBe('100.00'); // saldo gravado quando a pendência foi resolvida
    expect(await balanceOf(f.walletId)).toBe('100.00');
    expect(await ledgerCount(f.walletId, 'DEBIT')).toBe(1);
    expect(await ledgerCount(f.walletId, 'CREDIT')).toBe(2);
    await expectLedgerInvariant(f.walletId);

    const events = await outboxCounts(f.walletId);
    expect(events.WagerTransactionPendingReference).toBe(1);
    expect(events.WagerTransactionProcessed).toBe(2);
  }, 60_000);

  test('esgotadas as tentativas, a pendente é rejeitada e não renasce', async () => {
    const f = await newWallet('100.00');
    const bet = ext('bet-que-nunca-chega-a-tempo');
    const refundExt = ext('refund');
    await run(f, refundExt, '25.00', Kind.Refund, bet);

    let now = Date.now() + 61_000;
    const worker = workerFor(pick(0), () => new Date(now));

    for (let i = 1; i <= 7; i += 1) {
      await worker.runOnce();
      now += 61_000;
    }
    expect((await run(f, refundExt, '25.00', Kind.Refund, bet)).status).toBe(Status.PendingReference);

    await worker.runOnce(); // 8ª tentativa
    const rejected = await run(f, refundExt, '25.00', Kind.Refund, bet);
    expect(rejected).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      idempotentReplay: true,
    });
    expect(rejected.balance.amount).toBe('100.00');

    const events = await outboxCounts(f.walletId);
    expect(events.WagerTransactionPendingReference).toBe(1);
    expect(events.WagerTransactionRejected).toBe(1);

    // Terminal: a BET chegando depois não ressuscita o REFUND.
    await run(f, bet, '25.00', Kind.Bet);
    now += 61_000;
    await worker.runOnce();
    expect((await run(f, refundExt, '25.00', Kind.Refund, bet)).status).toBe(Status.Rejected);
    expect(await balanceOf(f.walletId)).toBe('75.00');
  }, 120_000);
});

describe('concorrência', () => {
  test('duas reversões simultâneas da mesma BET: uma aplica e a outra é ALREADY_REVERSED', async () => {
    const fixtures = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));
    await Promise.all(
      fixtures.map(async (f, i) => {
        const bet = ext('bet');
        await run(f, bet, '25.00', Kind.Bet);
        const [a, b] = await Promise.all([
          run(f, ext('r-a'), '25.00', Kind.Refund, bet, { instance: i }),
          run(f, ext('r-b'), '25.00', Kind.Rollback, bet, { instance: i + 1 }),
        ]);
        expect([a.status, b.status].sort()).toEqual([Status.Processed, Status.Rejected]);
        const loser = a.status === Status.Rejected ? a : b;
        expect(loser.failureCode).toBe(FailureCode.AlreadyReversed);
        expect(await balanceOf(f.walletId)).toBe('100.00');
        expect(await ledgerCount(f.walletId, 'CREDIT')).toBe(2);
        await expectLedgerInvariant(f.walletId);
      }),
    );
  }, 60_000);

  test('dois workers resolvendo a mesma pendência: o crédito acontece uma vez só', async () => {
    const f = await newWallet('100.00');
    const bet = ext('bet');
    const refundExt = ext('refund');
    await run(f, refundExt, '25.00', Kind.Refund, bet);
    await run(f, bet, '25.00', Kind.Bet);

    const clock = () => new Date(Date.now() + 61_000);
    await Promise.all([workerFor(pick(0), clock).runOnce(), workerFor(pick(1), clock).runOnce()]);

    expect(await balanceOf(f.walletId)).toBe('100.00');
    expect(await ledgerCount(f.walletId, 'CREDIT')).toBe(2);
    expect((await outboxCounts(f.walletId)).WagerTransactionProcessed).toBe(2);
    expect((await run(f, refundExt, '25.00', Kind.Refund, bet)).status).toBe(Status.Processed);
    await expectLedgerInvariant(f.walletId);
  }, 60_000);
});
