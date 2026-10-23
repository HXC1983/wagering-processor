import { Module } from '@nestjs/common';
import type { TransactionRunner } from '../shared/application/transaction-scope';
import { TRANSACTION_RUNNER } from '../infrastructure/tokens';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { WalletsController } from './presentation/wallets.controller';

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: OpenWalletUseCase,
      useFactory: (runner: TransactionRunner) => new OpenWalletUseCase(runner),
      inject: [TRANSACTION_RUNNER],
    },
  ],
})
export class WalletModule {}
