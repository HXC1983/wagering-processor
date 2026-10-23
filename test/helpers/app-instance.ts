import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/persistence/mikro-orm-transaction-runner';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.use-case';
import { OpenWalletUseCase } from '../../src/wallet/application/open-wallet.use-case';

export interface AppInstance {
  orm: MikroORM;
  openWallet: OpenWalletUseCase;
  processTransaction: ProcessWagerTransactionUseCase;
  close(): Promise<void>;
}

/** Cada instância tem o próprio ORM e o próprio pool de conexões, como processos separados teriam. */
export async function createInstance(): Promise<AppInstance> {
  const orm = await MikroORM.init(buildOrmConfig());
  const runner = new MikroOrmTransactionRunner(orm);
  return {
    orm,
    openWallet: new OpenWalletUseCase(runner),
    processTransaction: new ProcessWagerTransactionUseCase(runner),
    close: () => orm.close(true),
  };
}

export async function migrateToLatest(): Promise<void> {
  const orm = await MikroORM.init(buildOrmConfig());
  try {
    await orm.getMigrator<Migrator>().up();
  } finally {
    await orm.close(true);
  }
}

export async function query<T>(orm: MikroORM, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await orm.em.getConnection().execute(sql, params)) as unknown as T[];
}
