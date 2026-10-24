import { Module } from '@nestjs/common';
import { jsonLog } from '../shared/infrastructure/logger';
import type { Metrics } from '../shared/application/metrics';
import type { TransactionRunner } from '../shared/application/transaction-scope';
import { LEDGER_READER, METRICS, TRANSACTION_RUNNER, WALLET_READER } from '../infrastructure/tokens';
import { ListLedgerUseCase } from './application/list-ledger.use-case';
import type { LedgerReader } from './application/ledger-reader';
import { OpenWalletUseCase } from './application/open-wallet.use-case';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import type { WalletReader } from './application/wallet-reader';
import { WalletsController } from './presentation/wallets.controller';

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: OpenWalletUseCase,
      useFactory: (runner: TransactionRunner) => new OpenWalletUseCase(runner),
      inject: [TRANSACTION_RUNNER],
    },
    {
      provide: ListLedgerUseCase,
      useFactory: (wallets: WalletReader, ledger: LedgerReader) => new ListLedgerUseCase(wallets, ledger),
      inject: [WALLET_READER, LEDGER_READER],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (ledger: LedgerReader, metrics: Metrics) => new ReconcileWalletUseCase(ledger, metrics, jsonLog),
      inject: [LEDGER_READER, METRICS],
    },
  ],
})
export class WalletModule {}
