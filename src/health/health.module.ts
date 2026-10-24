import { Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DependencyCheck, PostgresCheck, SqsCheck } from '../infrastructure/health/dependency-checks';
import { createSqsClient, transactionsQueueUrl } from '../infrastructure/messaging/sqs.config';
import { MIKRO_ORM, READINESS_CHECKS } from '../infrastructure/tokens';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      useFactory: (orm: MikroORM): DependencyCheck[] => [
        new PostgresCheck(orm),
        new SqsCheck(createSqsClient(), transactionsQueueUrl()),
      ],
      inject: [MIKRO_ORM],
    },
    HealthService,
  ],
})
export class HealthModule {}
