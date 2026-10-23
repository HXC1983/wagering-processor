import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { LogFn } from '../../shared/application/log';
import type { MessageHandler } from '../../wagering/application/wager-message-handler';

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  /** Recebimentos antes de enviar à DLQ (o redrive do SQS, com o mesmo limite, é a rede de segurança). */
  maxReceives?: number;
  batchSize?: number;
  waitSeconds?: number;
  backoffBaseSeconds?: number;
  backoffCapSeconds?: number;
  log?: LogFn;
}

type Disposition = 'ack' | 'retry';

export class SqsConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;

  private readonly maxReceives: number;
  private readonly batchSize: number;
  private readonly waitSeconds: number;
  private readonly backoffBase: number;
  private readonly backoffCap: number;
  private readonly log: LogFn;

  constructor(
    private readonly client: SQSClient,
    private readonly handler: MessageHandler,
    private readonly options: SqsConsumerOptions,
  ) {
    this.maxReceives = options.maxReceives ?? 5;
    this.batchSize = options.batchSize ?? 10;
    this.waitSeconds = options.waitSeconds ?? 2;
    this.backoffBase = options.backoffBaseSeconds ?? 1;
    this.backoffCap = options.backoffCapSeconds ?? 60;
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  /** Encerramento ordenado: conclui a mensagem em andamento e devolve as demais do lote. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[] = [];
      try {
        this.abort = new AbortController();
        const out = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: this.batchSize,
            WaitTimeSeconds: this.waitSeconds,
            MessageSystemAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (error) {
        if (!this.running) {
          break; // receive abortado pelo stop()
        }
        this.log('error', 'sqs receive failed', { error: this.describe(error) });
        await this.sleep(1_000);
        continue;
      }
      await this.processBatch(messages);
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 1) {
      if (!this.running) {
        await this.release(messages.slice(i)); // SIGTERM: devolve o que não começou
        return;
      }
      const disposition = await this.handle(messages[i]);
      if (disposition === 'retry') {
        // Preserva a ordem do grupo FIFO: o restante do lote volta para a fila.
        await this.release(messages.slice(i + 1));
        return;
      }
    }
  }

  private async handle(message: Message): Promise<Disposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    try {
      const outcome = await this.handler.handle(message.Body ?? '');
      switch (outcome.kind) {
        case 'done':
          await this.ack(message);
          return 'ack';
        case 'permanent':
          await this.sendToDlq(message, 'permanent', `${outcome.code}: ${outcome.reason}`);
          return 'ack';
        case 'transient':
          if (receiveCount >= this.maxReceives) {
            await this.sendToDlq(message, 'retries-exhausted', outcome.reason);
            return 'ack';
          }
          await this.changeVisibility(message, this.backoffSeconds(receiveCount));
          return 'retry';
      }
    } catch (error) {
      // Falha ao confirmar ou mover: não apaga; a mensagem volta quando a visibilidade expirar.
      this.log('error', 'sqs disposition failed', { messageId: message.MessageId, error: this.describe(error) });
      return 'retry';
    }
  }

  private backoffSeconds(receiveCount: number): number {
    return Math.min(this.backoffBase * 2 ** (receiveCount - 1), this.backoffCap);
  }

  private async ack(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async sendToDlq(message: Message, kind: string, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body || '(vazio)',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: `${message.MessageId ?? randomUUID()}-dlq`,
        MessageAttributes: {
          failureKind: { DataType: 'String', StringValue: kind },
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 500) || 'desconhecido' },
        },
      }),
    );
    await this.ack(message);
    this.log('warn', 'message moved to dlq', { messageId: message.MessageId, kind, reason: reason.slice(0, 200) });
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(
      messages.map((message) =>
        this.changeVisibility(message, 0).catch(() => undefined), // melhor esforço
      ),
    );
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
