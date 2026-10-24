import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InMemoryMetrics } from '../../shared/infrastructure/in-memory-metrics';
import { METRICS } from '../tokens';

/** Sem autenticação, como os health checks (ver ARCHITECTURE.md). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: InMemoryMetrics) {}

  @Get()
  render(@Res() res: Response): void {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(this.metrics.render());
  }
}
