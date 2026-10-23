import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { asObject, parseMoney, requireString, requireUuidParam } from '../../infrastructure/http/parse';
import { WALLET_READER } from '../../infrastructure/tokens';
import { OpenWalletResult, OpenWalletUseCase } from '../application/open-wallet.use-case';
import { WalletNotFoundError } from '../application/errors';
import type { WalletReader } from '../application/wallet-reader';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(WALLET_READER) private readonly wallets: WalletReader,
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
}
