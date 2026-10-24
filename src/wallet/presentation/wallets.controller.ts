import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  asObject,
  optionalQuery,
  parseLimit,
  parseMoney,
  requireString,
  requireUuidParam,
} from '../../infrastructure/http/parse';
import { WALLET_READER } from '../../infrastructure/tokens';
import { WalletNotFoundError } from '../application/errors';
import { LedgerPage, ListLedgerUseCase } from '../application/list-ledger.use-case';
import { OpenWalletResult, OpenWalletUseCase } from '../application/open-wallet.use-case';
import { ReconcileWalletUseCase, ReconciliationResult } from '../application/reconcile-wallet.use-case';
import type { WalletReader } from '../application/wallet-reader';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(WALLET_READER) private readonly wallets: WalletReader,
    @Inject(ListLedgerUseCase) private readonly listLedger: ListLedgerUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: unknown): Promise<OpenWalletResult> {
    const input = asObject(body);
    return this.openWallet.execute({
      playerId: requireString(input, 'playerId'),
      initialBalance: parseMoney(input.initialBalance, 'initialBalance'),
    });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<OpenWalletResult> {
    const wallet = await this.wallets.findById(requireUuidParam(walletId, 'walletId'));
    if (!wallet) {
      throw new WalletNotFoundError(`wallet não encontrada: ${walletId}`);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  /** Ledger paginado por cursor opaco e estável (limit padrão 50, máximo 200). */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<LedgerPage> {
    return this.listLedger.execute({
      walletId: requireUuidParam(walletId, 'walletId'),
      cursor: optionalQuery(cursor, 'cursor'),
      limit: parseLimit(limit),
    });
  }

  /** Não cria nada: devolve 200 mesmo quando encontra divergência (sinalizada no corpo). */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string): Promise<ReconciliationResult> {
    return this.reconcileWallet.execute(requireUuidParam(walletId, 'walletId'));
  }
}
