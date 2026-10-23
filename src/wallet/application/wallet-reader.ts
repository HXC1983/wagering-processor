import type { Wallet } from '../domain/wallet';

export interface WalletReader {
  findById(walletId: string): Promise<Wallet | undefined>;
}
