import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Processo vivo. */
  @Get('live')
  live(): { status: 'ok' } {
    return this.health.live();
  }

  /** PostgreSQL e SQS alcançáveis; 503 com Retry-After caso contrário. */
  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const result = await this.health.ready();
    if (!result.ok) {
      res.setHeader('Retry-After', '1');
    }
    res.status(result.ok ? 200 : 503).json({
      status: result.ok ? 'ready' : 'unavailable',
      checks: result.checks,
    });
  }
}
