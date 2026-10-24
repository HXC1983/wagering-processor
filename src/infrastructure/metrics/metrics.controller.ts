import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InMemoryMetrics } from '../../shared/infrastructure/in-memory-metrics';
import { METRICS, OUTBOX_LAG_PROBE } from '../tokens';
import { OutboxLagProbe } from './outbox-lag-probe';

/** Sem autenticação, como os health checks (ver ARCHITECTURE.md). */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: InMemoryMetrics,
    @Inject(OUTBOX_LAG_PROBE) private readonly lag: OutboxLagProbe,
  ) {}

  @Get()
  async render(@Res() res: Response): Promise<void> {
    let text = this.metrics.render();
    try {
      const lag = await this.lag.snapshot();
      text += `# TYPE outbox_pending_messages gauge\noutbox_pending_messages ${lag.pending}\n`;
      text += `# TYPE outbox_oldest_pending_age_seconds gauge\noutbox_oldest_pending_age_seconds ${lag.oldestAgeSeconds.toFixed(3)}\n`;
    } catch {
      // Banco indisponível: expõe só as métricas em memória.
    }
    res.type('text/plain; version=0.0.4; charset=utf-8').send(text);
  }
}
