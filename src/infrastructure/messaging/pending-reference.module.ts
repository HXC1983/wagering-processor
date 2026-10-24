import { Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { jsonLog } from '../../shared/infrastructure/logger';
import type { TransactionRunner } from '../../shared/application/transaction-scope';
import {
  PendingReferenceReader,
  ReprocessPendingReferencesUseCase,
} from '../../wagering/application/reprocess-pending-references.use-case';
import { MikroOrmPendingReferenceReader } from '../persistence/mikro-orm-pending-reference-reader';
import { MIKRO_ORM, PENDING_REFERENCE_READER, TRANSACTION_RUNNER } from '../tokens';
import { PendingReferenceWorker } from './pending-reference.worker';

@Module({
  providers: [
    {
      provide: PENDING_REFERENCE_READER,
      useFactory: (orm: MikroORM): PendingReferenceReader => new MikroOrmPendingReferenceReader(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: ReprocessPendingReferencesUseCase,
      useFactory: (runner: TransactionRunner, reader: PendingReferenceReader) =>
        new ReprocessPendingReferencesUseCase(runner, reader, {
          batchSize: Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 20),
          log: jsonLog,
        }),
      inject: [TRANSACTION_RUNNER, PENDING_REFERENCE_READER],
    },
    PendingReferenceWorker,
  ],
})
export class PendingReferenceModule {}
