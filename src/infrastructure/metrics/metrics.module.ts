import { Global, Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { registerKnownSeries } from '../../shared/application/metrics';
import { InMemoryMetrics } from '../../shared/infrastructure/in-memory-metrics';
import { METRICS, MIKRO_ORM, OUTBOX_LAG_PROBE } from '../tokens';
import { MetricsController } from './metrics.controller';
import { OutboxLagProbe } from './outbox-lag-probe';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS,
      useFactory: () => {
        const metrics = new InMemoryMetrics();
        registerKnownSeries(metrics);
        return metrics;
      },
    },
    { provide: OUTBOX_LAG_PROBE, useFactory: (orm: MikroORM) => new OutboxLagProbe(orm), inject: [MIKRO_ORM] },
  ],
  exports: [METRICS],
})
export class MetricsModule {}
