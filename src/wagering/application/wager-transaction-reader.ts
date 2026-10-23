import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionReader {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
}
