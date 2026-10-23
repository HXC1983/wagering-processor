import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/database/database.module';
import { OutboxModule } from './infrastructure/messaging/outbox.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { AuthGuard } from './shared/infrastructure/auth.guard';
import { WageringModule } from './wagering/wagering.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [DatabaseModule, OutboxModule, WalletModule, WageringModule],
  controllers: [HealthController],
  providers: [HealthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
