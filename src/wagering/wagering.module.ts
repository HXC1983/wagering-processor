import { Module } from '@nestjs/common';
import type { TransactionRunner } from '../shared/application/transaction-scope';
import { TRANSACTION_RUNNER } from '../infrastructure/tokens';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WageringController } from './presentation/wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (runner: TransactionRunner) => new ProcessWagerTransactionUseCase(runner),
      inject: [TRANSACTION_RUNNER],
    },
  ],
})
export class WageringModule {}
