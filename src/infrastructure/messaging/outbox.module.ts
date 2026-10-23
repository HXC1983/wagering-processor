import { Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { jsonLog } from '../../shared/infrastructure/logger';
import type { EventPublisher, OutboxRunner } from '../../wagering/application/outbox-ports';
import { OutboxRelay } from '../../wagering/application/outbox-relay';
import { MikroOrmOutboxRunner } from '../persistence/mikro-orm-outbox-runner';
import { EVENT_PUBLISHER, MIKRO_ORM, OUTBOX_RUNNER, SQS_CLIENT } from '../tokens';
import { OutboxWorker } from './outbox.worker';
import { SqsEventPublisher } from './sqs-event-publisher';
import { createSqsClient, eventsQueueUrl } from './sqs.config';

@Module({
  providers: [
    { provide: SQS_CLIENT, useFactory: (): SQSClient => createSqsClient() },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (client: SQSClient): EventPublisher => new SqsEventPublisher(client, eventsQueueUrl()),
      inject: [SQS_CLIENT],
    },
    {
      provide: OUTBOX_RUNNER,
      useFactory: (orm: MikroORM): OutboxRunner => new MikroOrmOutboxRunner(orm),
      inject: [MIKRO_ORM],
    },
    {
      provide: OutboxRelay,
      useFactory: (runner: OutboxRunner, publisher: EventPublisher) =>
        new OutboxRelay(runner, publisher, {
          batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 20),
          log: jsonLog,
        }),
      inject: [OUTBOX_RUNNER, EVENT_PUBLISHER],
    },
    OutboxWorker,
  ],
})
export class OutboxModule {}
