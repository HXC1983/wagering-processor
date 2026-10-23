import type { MikroORM } from '@mikro-orm/postgresql';
import type { WagerTransactionReader } from '../../wagering/application/wager-transaction-reader';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import type { WalletReader } from '../../wallet/application/wallet-reader';
import type { Wallet } from '../../wallet/domain/wallet';
import { wagerTransactionFromRow, walletFromRow } from './mappers';
import { WagerTransactionSchema, WalletSchema } from './schemas';

/** Leituras sem lock: cada chamada usa um EntityManager próprio (fork). */
export class MikroOrmWalletReader implements WalletReader {
  constructor(private readonly orm: MikroORM) {}

  async findById(walletId: string): Promise<Wallet | undefined> {
    const row = await this.orm.em.fork().findOne(WalletSchema, { id: walletId });
    return row ? walletFromRow(row) : undefined;
  }
}

export class MikroOrmWagerTransactionReader implements WagerTransactionReader {
  constructor(private readonly orm: MikroORM) {}

  async findById(transactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.orm.em.fork().findOne(WagerTransactionSchema, { id: transactionId });
    return row ? wagerTransactionFromRow(row) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.orm
      .em.fork()
      .findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return row ? wagerTransactionFromRow(row) : undefined;
  }
}
