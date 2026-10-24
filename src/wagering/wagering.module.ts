import { Module } from '@nestjs/common';
import { METRICS, TRANSACTION_RUNNER } from '../infrastructure/tokens';
import type { Metrics } from '../shared/application/metrics';
import type { TransactionRunner } from '../shared/application/transaction-scope';
import { jsonLog } from '../shared/infrastructure/logger';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WageringController } from './presentation/wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (runner: TransactionRunner, metrics: Metrics) =>
        new ProcessWagerTransactionUseCase(runner, undefined, undefined, { metrics, log: jsonLog }),
      inject: [TRANSACTION_RUNNER, METRICS],
    },
  ],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
