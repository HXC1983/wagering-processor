import { describe, expect, test } from 'bun:test';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from '../domain/ledger-direction';
import { Wallet } from '../domain/wallet';
import { WalletNotFoundError } from './errors';
import { decodeCursor, encodeCursor, InvalidCursorError } from './ledger-cursor';
import type { LedgerEntryView, LedgerPageResult, LedgerReader } from './ledger-reader';
import { ListLedgerUseCase } from './list-ledger.use-case';
import type { WalletReader } from './wallet-reader';

const WALLET_ID = 'w-1';

function entry(seq: number): LedgerEntryView {
  const money = { amount: '10.00', currency: 'BRL' };
  return {
    seq: String(seq),
    id: `e-${seq}`,
    transactionId: `t-${seq}`,
    direction: LedgerDirection.Debit,
    money,
    balanceBefore: money,
    balanceAfter: money,
    createdAt: '2026-10-23T15:00:00.000Z',
  };
}

class FakeLedger implements LedgerReader {
  constructor(private readonly seqs: number[]) {}

  async findPage(_walletId: string, afterSeq: string, limit: number): Promise<LedgerPageResult> {
    const rows = this.seqs.filter((seq) => BigInt(seq) > BigInt(afterSeq)).slice(0, limit + 1);
    return { entries: rows.slice(0, limit).map(entry), hasMore: rows.length > limit };
  }

  async summarize(): Promise<undefined> {
    return undefined;
  }
}

const existingWallet: WalletReader = {
  async findById(id: string) {
    return id === WALLET_ID
      ? Wallet.open({
          id,
          playerId: 'p-1',
          initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
          now: new Date(),
        })
      : undefined;
  },
};

describe('ListLedgerUseCase', () => {
  const useCase = new ListLedgerUseCase(existingWallet, new FakeLedger([3, 7, 8, 12, 20]));

  test('percorre todas as páginas, em ordem, sem repetir e sem expor o seq', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await useCase.execute({ walletId: WALLET_ID, cursor, limit: 2 });
      expect(page.items.every((item) => !('seq' in item))).toBe(true);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(seen).toEqual(['e-3', 'e-7', 'e-8', 'e-12', 'e-20']);
    expect(pages).toBe(3);
  });

  test('a última página não tem nextCursor', async () => {
    const page = await useCase.execute({ walletId: WALLET_ID, limit: 10 });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  test('o cursor aponta para o último item entregue', async () => {
    const page = await useCase.execute({ walletId: WALLET_ID, limit: 2 });
    expect(decodeCursor(page.nextCursor as string)).toBe('7');
  });

  test('cursor inválido lança InvalidCursorError', async () => {
    await expect(useCase.execute({ walletId: WALLET_ID, cursor: 'lixo', limit: 2 })).rejects.toThrow(
      InvalidCursorError,
    );
  });

  test('carteira inexistente lança WalletNotFoundError', async () => {
    await expect(
      useCase.execute({ walletId: 'w-x', cursor: encodeCursor('1'), limit: 2 }),
    ).rejects.toThrow(WalletNotFoundError);
  });
});
