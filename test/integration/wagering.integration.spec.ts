import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { InvalidMoneyError } from '../../src/shared/domain/errors';
import { IdempotencyConflictError, UnsupportedTransactionKindError } from '../../src/wagering/application/errors';
import type { ProcessWagerTransactionCommand } from '../../src/wagering/application/process-wager-transaction.use-case';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../../src/wallet/application/errors';
import { AppInstance, createInstance, migrateToLatest, query } from '../helpers/app-instance';

const PROVIDER = 'provider-test';
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

async function newWallet(balance = '100.00', currency = 'BRL'): Promise<Fixture> {
  const playerId = randomUUID();
  const wallet = await pick(0).openWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency },
  });
  return { walletId: wallet.id, playerId };
}

function command(
  fixture: Fixture,
  externalId: string,
  amount: string,
  kind: WagerTransactionKind = WagerTransactionKind.Bet,
): ProcessWagerTransactionCommand {
  return {
    providerId: PROVIDER,
    externalTransactionId: externalId,
    idempotencyKey: `${PROVIDER}:${externalId}`,
    playerId: fixture.playerId,
    walletId: fixture.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function storedBalance(walletId: string): Promise<string> {
  const [row] = await query<{ balance: string }>(
    instances[0].orm,
    'select balance::text as balance from wallets where id = ?',
    [walletId],
  );
  return row.balance;
}

async function ledgerCount(walletId: string, direction?: string): Promise<number> {
  const [row] = direction
    ? await query<{ n: number }>(
        instances[0].orm,
        'select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = ?',
        [walletId, direction],
      )
    : await query<{ n: number }>(
        instances[0].orm,
        'select count(*)::int as n from wallet_ledger_entries where wallet_id = ?',
        [walletId],
      );
  return row.n;
}

async function outboxCounts(walletId: string): Promise<Record<string, number>> {
  const rows = await query<{ event_type: string; n: number }>(
    instances[0].orm,
    'select event_type, count(*)::int as n from outbox_messages where aggregate_id = ? group by event_type',
    [walletId],
  );
  return Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
}

/** Invariante final: saldo guardado == saldo reconstruído pelo ledger. */
async function expectLedgerInvariant(walletId: string): Promise<void> {
  const [row] = await query<{ stored: string; calculated: string }>(
    instances[0].orm,
    `select w.balance::text as stored,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as calculated
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ?
      group by w.id`,
    [walletId],
  );
  expect(row.calculated).toBe(row.stored);
}

describe('cenário obrigatório (seção 8)', () => {
  test('100.00 e duas apostas simultâneas de 80.00: uma processa, outra é rejeitada', async () => {
    const rounds = Array.from({ length: 20 }, async (_, i) => {
      const fixture = await newWallet('100.00');
      const results = await Promise.all([
        pick(i).processTransaction.execute(command(fixture, `bet-a-${randomUUID()}`, '80.00')),
        pick(i + 1).processTransaction.execute(command(fixture, `bet-b-${randomUUID()}`, '80.00')),
      ]);
      return { fixture, results };
    });

    for (const { fixture, results } of await Promise.all(rounds)) {
      expect(results.map((r) => r.status).sort()).toEqual([
        WagerTransactionStatus.Processed,
        WagerTransactionStatus.Rejected,
      ]);
      const rejected = results.find((r) => r.status === WagerTransactionStatus.Rejected);
      expect(rejected?.failureCode).toBe(FailureCode.InsufficientFunds);

      expect(await storedBalance(fixture.walletId)).toBe('20.00');
      expect(await ledgerCount(fixture.walletId, 'DEBIT')).toBe(1);
      await expectLedgerInvariant(fixture.walletId);

      const events = await outboxCounts(fixture.walletId);
      expect(events.WagerTransactionProcessed).toBe(1);
      expect(events.WagerTransactionRejected).toBe(1);
      expect(events.WalletBalanceChanged).toBe(2); // abertura + aposta
    }
  }, 60_000);
});

describe('idempotência', () => {
  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const fixture = await newWallet('100.00');
    const duplicated = command(fixture, `dup-${randomUUID()}`, '25.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => pick(i).processTransaction.execute(duplicated)),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    for (const result of results) {
      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe('75.00');
    }

    expect(await storedBalance(fixture.walletId)).toBe('75.00');
    expect(await ledgerCount(fixture.walletId, 'DEBIT')).toBe(1);
    await expectLedgerInvariant(fixture.walletId);

    const events = await outboxCounts(fixture.walletId);
    expect(events.WagerTransactionProcessed).toBe(1);
    expect(events.WalletBalanceChanged).toBe(2);
  }, 60_000);

  test('mesma key com payload diferente é conflito, e não replay', async () => {
    const fixture = await newWallet('100.00');
    const first = command(fixture, `conflict-${randomUUID()}`, '25.00');
    await pick(0).processTransaction.execute(first);

    const changed = { ...first, money: { amount: '30.00', currency: 'BRL' } };
    await expect(pick(1).processTransaction.execute(changed)).rejects.toThrow(IdempotencyConflictError);

    expect(await storedBalance(fixture.walletId)).toBe('75.00');
    expect(await ledgerCount(fixture.walletId, 'DEBIT')).toBe(1);
  });

  test('o replay devolve o saldo observado na época, e não o saldo atual', async () => {
    const fixture = await newWallet('100.00');
    const bet = command(fixture, `bet-${randomUUID()}`, '25.00');
    const original = await pick(0).processTransaction.execute(bet);
    expect(original.balance.amount).toBe('75.00');

    const win = await pick(1).processTransaction.execute(
      command(fixture, `win-${randomUUID()}`, '10.00', WagerTransactionKind.Win),
    );
    expect(win.balance.amount).toBe('85.00');

    const replay = await pick(2).processTransaction.execute(bet);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.balance.amount).toBe('75.00');
  });

  test('o replay de uma rejeição devolve a rejeição original', async () => {
    const fixture = await newWallet('10.00');
    const bet = command(fixture, `rej-${randomUUID()}`, '80.00');
    const first = await pick(0).processTransaction.execute(bet);
    const replay = await pick(1).processTransaction.execute(bet);

    expect(first.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('10.00');
  });
});

describe('concorrência entre wallets', () => {
  test('wallets distintas são processadas em paralelo, sem bloqueio entre si', async () => {
    const fixtures = await Promise.all(Array.from({ length: 30 }, () => newWallet('100.00')));
    const results = await Promise.all(
      fixtures.map((fixture, i) =>
        pick(i).processTransaction.execute(command(fixture, `par-${randomUUID()}`, '10.00')),
      ),
    );

    for (const result of results) {
      expect(result.status).toBe(WagerTransactionStatus.Processed);
    }
    for (const fixture of fixtures) {
      expect(await storedBalance(fixture.walletId)).toBe('90.00');
      await expectLedgerInvariant(fixture.walletId);
    }
  }, 60_000);

  test('muitas apostas pequenas na mesma wallet nunca estouram o saldo', async () => {
    const fixture = await newWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        pick(i).processTransaction.execute(command(fixture, `hot-${i}-${randomUUID()}`, '10.00')),
      ),
    );

    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);
    expect(processed).toHaveLength(10);
    expect(rejected).toHaveLength(20);
    expect(await storedBalance(fixture.walletId)).toBe('0.00');
    expect(await ledgerCount(fixture.walletId, 'DEBIT')).toBe(10);
    await expectLedgerInvariant(fixture.walletId);
  }, 60_000);
});

describe('regras de negócio', () => {
  test('WIN credita o saldo', async () => {
    const fixture = await newWallet('100.00');
    const result = await pick(0).processTransaction.execute(
      command(fixture, `win-${randomUUID()}`, '40.00', WagerTransactionKind.Win),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('140.00');
    expect(await ledgerCount(fixture.walletId, 'CREDIT')).toBe(2); // abertura + WIN
    await expectLedgerInvariant(fixture.walletId);
  });

  test('LOSS registra o resultado sem mover saldo, sem lançamento e sem WalletBalanceChanged', async () => {
    const fixture = await newWallet('100.00');
    const result = await pick(0).processTransaction.execute(
      command(fixture, `loss-${randomUUID()}`, '10.00', WagerTransactionKind.Loss),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('100.00');
    expect(await ledgerCount(fixture.walletId)).toBe(1); // só a abertura

    const events = await outboxCounts(fixture.walletId);
    expect(events.WagerTransactionProcessed).toBe(1);
    expect(events.WalletBalanceChanged).toBe(1); // só a abertura
  });

  test('moeda diferente da wallet é rejeitada sem alterar nada', async () => {
    const fixture = await newWallet('100.00');
    const usd = { ...command(fixture, `usd-${randomUUID()}`, '10.00'), money: { amount: '10.00', currency: 'USD' } };
    const result = await pick(0).processTransaction.execute(usd);
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(await storedBalance(fixture.walletId)).toBe('100.00');
    expect(await ledgerCount(fixture.walletId)).toBe(1);
  });

  test('jogador diferente do dono da wallet é rejeitado', async () => {
    const fixture = await newWallet('100.00');
    const other = { ...command(fixture, `other-${randomUUID()}`, '10.00'), playerId: randomUUID() };
    const result = await pick(0).processTransaction.execute(other);
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(await storedBalance(fixture.walletId)).toBe('100.00');
  });

  test('wallet inexistente lança WalletNotFoundError', async () => {
    const ghost = { walletId: randomUUID(), playerId: randomUUID() };
    await expect(
      pick(0).processTransaction.execute(command(ghost, `ghost-${randomUUID()}`, '10.00')),
    ).rejects.toThrow(WalletNotFoundError);
  });

  test('payload inválido é recusado antes de tocar no banco', async () => {
    const fixture = await newWallet('100.00');
    await expect(
      pick(0).processTransaction.execute(command(fixture, `bad-${randomUUID()}`, '10')),
    ).rejects.toThrow(InvalidMoneyError);
  });

  test('REFUND ainda não é suportado (Bloco E)', async () => {
    const fixture = await newWallet('100.00');
    const refund = {
      ...command(fixture, `refund-${randomUUID()}`, '10.00', WagerTransactionKind.Refund),
      referenceExternalTransactionId: 'qualquer',
    };
    await expect(pick(0).processTransaction.execute(refund)).rejects.toThrow(UnsupportedTransactionKindError);
  });
});

describe('abertura de wallet', () => {
  test('saldo inicial > 0 gera OPENING, lançamento CREDIT e evento na mesma transação', async () => {
    const fixture = await newWallet('1000.00');
    expect(await storedBalance(fixture.walletId)).toBe('1000.00');
    expect(await ledgerCount(fixture.walletId, 'CREDIT')).toBe(1);
    expect((await outboxCounts(fixture.walletId)).WalletBalanceChanged).toBe(1);
    await expectLedgerInvariant(fixture.walletId);
  });

  test('saldo inicial zero não gera OPENING nem lançamento', async () => {
    const fixture = await newWallet('0.00');
    expect(await storedBalance(fixture.walletId)).toBe('0.00');
    expect(await ledgerCount(fixture.walletId)).toBe(0);
    const [row] = await query<{ n: number }>(
      instances[0].orm,
      'select count(*)::int as n from wager_transactions where wallet_id = ?',
      [fixture.walletId],
    );
    expect(row.n).toBe(0);
  });

  test('wallet duplicada para o mesmo jogador e moeda é conflito', async () => {
    const playerId = randomUUID();
    await pick(0).openWallet.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
    await expect(
      pick(1).openWallet.execute({ playerId, initialBalance: { amount: '20.00', currency: 'BRL' } }),
    ).rejects.toThrow(WalletAlreadyExistsError);

    // outra moeda para o mesmo jogador é permitido
    const usd = await pick(2).openWallet.execute({
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(usd.balance.currency).toBe('USD');
  });
});
