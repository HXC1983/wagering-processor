import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionRunner } from '../../shared/application/transaction-scope';
import { MikroOrmReaders } from './readers-factory';
import { MikroOrmTransactionRunner } from '../persistence/mikro-orm-transaction-runner';
import {
  MIKRO_ORM,
  TRANSACTION_RUNNER,
  WAGER_TRANSACTION_READER,
  WALLET_READER,
} from '../tokens';
import { buildOrmConfig } from './mikro-orm.config';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

/** Conexão única (pool) compartilhada pela aplicação; fecha no shutdown (SIGTERM). */
@Global()
@Module({
  providers: [
    { provide: MIKRO_ORM, useFactory: async () => MikroORM.init(buildOrmConfig()) },
    {
      provide: TRANSACTION_RUNNER,
      useFactory: (orm: MikroORM): TransactionRunner => new MikroOrmTransactionRunner(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: WALLET_READER,
      useFactory: (orm: MikroORM) => MikroOrmReaders.wallets(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: WAGER_TRANSACTION_READER,
      useFactory: (orm: MikroORM) => MikroOrmReaders.transactions(orm),
      inject: [MIKRO_ORM],
    },
    DatabaseLifecycle,
  ],
  exports: [MIKRO_ORM, TRANSACTION_RUNNER, WALLET_READER, WAGER_TRANSACTION_READER],
})
export class DatabaseModule {}
