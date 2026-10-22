import { Controller, Get, Inject } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.health.live();
  }
}
