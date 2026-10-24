import { Inject, Injectable } from '@nestjs/common';
import type { DependencyCheck } from '../infrastructure/health/dependency-checks';
import { READINESS_CHECKS } from '../infrastructure/tokens';
import { jsonLog } from '../shared/infrastructure/logger';

export interface ReadinessResult {
  ok: boolean;
  checks: Record<string, 'up' | 'down'>;
}

@Injectable()
export class HealthService {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: DependencyCheck[]) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async ready(): Promise<ReadinessResult> {
    const results = await Promise.all(
      this.checks.map(async (dependency): Promise<[string, 'up' | 'down']> => {
        try {
          await dependency.check();
          return [dependency.name, 'up'];
        } catch (error) {
          jsonLog('warn', 'readiness check failed', {
            dependency: dependency.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return [dependency.name, 'down'];
        }
      }),
    );
    return { ok: results.every(([, state]) => state === 'up'), checks: Object.fromEntries(results) };
  }
}
