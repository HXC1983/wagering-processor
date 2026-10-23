import type { LogFn } from '../../shared/application/log';
import { DomainError } from '../../shared/domain/domain-error';
import type {
  ProcessOptions,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from './process-wager-transaction.use-case';
import { ParsedWagerMessage, parseWagerTransactionRequested } from './wager-message';

export type HandleOutcome =
  /** Resultado de negócio registrado (aceita, rejeitada ou replay): pode apagar a mensagem. */
  | { kind: 'done'; status: string; replay: boolean; transactionId: string }
  /** Nunca poderá ser processada: vai direto para a DLQ. */
  | { kind: 'permanent'; code: string; reason: string }
  /** Falha de infraestrutura: tentar de novo com backoff. */
  | { kind: 'transient'; reason: string };

export interface MessageHandler {
  handle(body: string): Promise<HandleOutcome>;
}

export interface TransactionProcessor {
  execute(
    command: ProcessWagerTransactionCommand,
    options?: ProcessOptions,
  ): Promise<ProcessWagerTransactionResult>;
}

export const DEFAULT_CONSUMER_NAME = 'wager-transactions-consumer';

/**
 * Traduz uma mensagem SQS no MESMO caso de uso da API e classifica o resultado:
 * resultado registrado (ack), erro permanente (DLQ) ou erro transitório (retry).
 */
export class WagerMessageHandler implements MessageHandler {
  constructor(
    private readonly processor: TransactionProcessor,
    private readonly options: { consumerName?: string; log?: LogFn } = {},
  ) {}

  async handle(body: string): Promise<HandleOutcome> {
    const log = this.options.log ?? (() => undefined);
    const consumerName = this.options.consumerName ?? DEFAULT_CONSUMER_NAME;

    let parsed: ParsedWagerMessage;
    try {
      parsed = parseWagerTransactionRequested(body);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log('warn', 'message discarded: invalid format', { reason });
      return { kind: 'permanent', code: 'INVALID_MESSAGE', reason };
    }

    const { command, messageId, payloadHash } = parsed;
    const fields = {
      correlationId: messageId,
      messageId,
      walletId: command.walletId,
      providerId: command.providerId,
    };

    try {
      const result = await this.processor.execute(command, {
        inbox: { consumerName, messageId, payloadHash },
      });
      log('info', 'message processed', {
        ...fields,
        transactionId: result.transactionId,
        status: result.status,
        replay: result.idempotentReplay,
      });
      return {
        kind: 'done',
        status: result.status,
        replay: result.idempotentReplay,
        transactionId: result.transactionId,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof DomainError) {
        // Não gera registro auditável e nunca será processada: preservar na DLQ.
        log('warn', 'message failed permanently', { ...fields, code: error.code, reason });
        return { kind: 'permanent', code: error.code, reason };
      }
      log('warn', 'message failed transiently', { ...fields, reason });
      return { kind: 'transient', reason };
    }
  }
}
