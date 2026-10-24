import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { MetricsModule } from './infrastructure/metrics/metrics.module';
import { OutboxModule } from './infrastructure/messaging/outbox.module';
import { SqsConsumerModule } from './infrastructure/messaging/sqs-consumer.module';
import { AuthGuard } from './shared/infrastructure/auth.guard';
import { WageringModule } from './wagering/wagering.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    DatabaseModule,
    MetricsModule,
    HealthModule,
    OutboxModule,
    SqsConsumerModule,
    WalletModule,
    WageringModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
