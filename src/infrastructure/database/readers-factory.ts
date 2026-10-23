import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmWagerTransactionReader, MikroOrmWalletReader } from '../persistence/mikro-orm-readers';

export const MikroOrmReaders = {
  wallets: (orm: MikroORM) => new MikroOrmWalletReader(orm),
  transactions: (orm: MikroORM) => new MikroOrmWagerTransactionReader(orm),
};
