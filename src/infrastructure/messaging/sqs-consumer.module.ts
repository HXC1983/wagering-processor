import { Module } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Metrics } from '../../shared/application/metrics';
import { jsonLog } from '../../shared/infrastructure/logger';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/process-wager-transaction.use-case';
import { WagerMessageHandler } from '../../wagering/application/wager-message-handler';
import { WageringModule } from '../../wagering/wagering.module';
import { METRICS, SQS_CONSUMER_CLIENT } from '../tokens';
import { SqsConsumer } from './sqs-consumer';
import { SqsConsumerWorker } from './sqs-consumer.worker';
import { createSqsClient, transactionsDlqUrl, transactionsQueueUrl } from './sqs.config';

@Module({
  imports: [WageringModule],
  providers: [
    { provide: SQS_CONSUMER_CLIENT, useFactory: (): SQSClient => createSqsClient() },
    {
      provide: WagerMessageHandler,
      useFactory: (useCase: ProcessWagerTransactionUseCase) =>
        new WagerMessageHandler(useCase, { log: jsonLog }),
      inject: [ProcessWagerTransactionUseCase],
    },
    {
      provide: SqsConsumer,
      useFactory: (client: SQSClient, handler: WagerMessageHandler, metrics: Metrics) =>
        new SqsConsumer(client, handler, {
          queueUrl: transactionsQueueUrl(),
          dlqUrl: transactionsDlqUrl(),
          maxReceives: Number(process.env.SQS_MAX_RECEIVES ?? 5),
          log: jsonLog,
          metrics,
        }),
      inject: [SQS_CONSUMER_CLIENT, WagerMessageHandler, METRICS],
    },
    SqsConsumerWorker,
  ],
})
export class SqsConsumerModule {}
