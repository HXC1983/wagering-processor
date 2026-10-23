import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { SqsConsumer } from './sqs-consumer';

/** Sob `bun test` o consumidor fica desligado, a menos que SQS_CONSUMER_ENABLED=true. */
function isConsumerEnabled(): boolean {
  const flag = process.env.SQS_CONSUMER_ENABLED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'test';
}

@Injectable()
export class SqsConsumerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(SqsConsumer) private readonly consumer: SqsConsumer) {}

  onApplicationBootstrap(): void {
    if (isConsumerEnabled()) {
      this.consumer.start();
    }
  }

  /** SIGTERM: conclui a mensagem em andamento e devolve as demais do lote. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}
