import type { LogFn } from '../../shared/application/log';
import { MetricName, Metrics } from '../../shared/application/metrics';
import type { MoneyProps } from '../../shared/domain/money';
import { WalletNotFoundError } from './errors';
import type { LedgerReader } from './ledger-reader';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo guardado com o saldo reconstruído pelo ledger.
 * Divergências NÃO são corrigidas: são logadas, contadas em métrica e sinalizadas na resposta.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly ledger: LedgerReader,
    private readonly metrics: Metrics,
    private readonly log: LogFn = () => undefined,
  ) {
    // Inicializa o contador em 0: a métrica aparece mesmo antes da primeira divergência.
    this.metrics.increment(MetricName.ReconciliationDivergences, {}, 0);
  }

  async execute(walletId: string): Promise<ReconciliationResult> {
    const summary = await this.ledger.summarize(walletId);
    if (!summary) {
      throw new WalletNotFoundError(`wallet não encontrada: ${walletId}`);
    }

    const difference = summary.storedBalance.subtract(summary.calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.increment(MetricName.ReconciliationDivergences);
      this.log('error', 'wallet ledger divergence detected', {
        walletId,
        difference: difference.toString(),
        checkedEntries: summary.checkedEntries,
      });
    }

    return {
      walletId,
      storedBalance: summary.storedBalance.toJSON(),
      calculatedBalance: summary.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.checkedEntries,
    };
  }
}
