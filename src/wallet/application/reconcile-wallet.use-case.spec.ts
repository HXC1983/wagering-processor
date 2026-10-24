import { describe, expect, test } from 'bun:test';
import { Money } from '../../shared/domain/money';
import { InMemoryMetrics } from '../../shared/infrastructure/in-memory-metrics';
import { WalletNotFoundError } from './errors';
import type { LedgerReader, LedgerSummary } from './ledger-reader';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

class FakeLedger implements LedgerReader {
  constructor(private readonly summary?: LedgerSummary) {}

  async findPage(): Promise<never> {
    throw new Error('não usado');
  }

  async summarize(): Promise<LedgerSummary | undefined> {
    return this.summary;
  }
}

function setup(summary?: LedgerSummary) {
  const metrics = new InMemoryMetrics();
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const useCase = new ReconcileWalletUseCase(new FakeLedger(summary), metrics, (level, message, fields) =>
    logs.push({ level, message, fields }),
  );
  return { useCase, metrics, logs };
}

describe('ReconcileWalletUseCase', () => {
  test('o contador de divergências já nasce em 0', () => {
    expect(setup().metrics.render()).toContain('reconciliation_divergences_total 0');
  });

  test('saldo igual ao ledger: consistente, sem log nem métrica', async () => {
    const { useCase, metrics, logs } = setup({
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      checkedEntries: 2,
    });
    const result = await useCase.execute('w-1');
    expect(result).toEqual({
      walletId: 'w-1',
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    expect(logs).toHaveLength(0);
    expect(metrics.render()).toContain('reconciliation_divergences_total 0');
  });

  test('divergência: sinalizada na resposta, logada e contada (e nada é corrigido)', async () => {
    const { useCase, metrics, logs } = setup({
      storedBalance: brl('999.00'),
      calculatedBalance: brl('75.00'),
      checkedEntries: 2,
    });
    const result = await useCase.execute('w-1');
    expect(result.consistent).toBe(false);
    expect(result.difference).toEqual({ amount: '924.00', currency: 'BRL' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', fields: { walletId: 'w-1', difference: '924.00' } });
    expect(metrics.render()).toContain('reconciliation_divergences_total 1');
  });

  test('saldo guardado menor que o do ledger gera diferença negativa', async () => {
    const { useCase } = setup({
      storedBalance: brl('10.00'),
      calculatedBalance: brl('25.00'),
      checkedEntries: 1,
    });
    const result = await useCase.execute('w-1');
    expect(result.consistent).toBe(false);
    expect(result.difference).toEqual({ amount: '-15.00', currency: 'BRL' });
  });

  test('carteira inexistente lança WalletNotFoundError', async () => {
    await expect(setup(undefined).useCase.execute('w-x')).rejects.toThrow(WalletNotFoundError);
  });
});
