import { Global, Module } from '@nestjs/common';
import { InMemoryMetrics } from '../../shared/infrastructure/in-memory-metrics';
import { METRICS } from '../tokens';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [{ provide: METRICS, useFactory: () => new InMemoryMetrics() }],
  exports: [METRICS],
})
export class MetricsModule {}
