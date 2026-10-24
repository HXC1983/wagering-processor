import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmLedgerReader } from '../persistence/mikro-orm-ledger-reader';
import { MikroOrmWagerTransactionReader, MikroOrmWalletReader } from '../persistence/mikro-orm-readers';

export const MikroOrmReaders = {
  wallets: (orm: MikroORM) => new MikroOrmWalletReader(orm),
  transactions: (orm: MikroORM) => new MikroOrmWagerTransactionReader(orm),
  ledger: (orm: MikroORM) => new MikroOrmLedgerReader(orm),
};
