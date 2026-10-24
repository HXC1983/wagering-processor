import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { DependencyCheck } from '../infrastructure/health/dependency-checks';
import { READINESS_CHECKS } from '../infrastructure/tokens';
import { jsonLog } from '../shared/infrastructure/logger';

export interface ReadinessResult {
  ok: boolean;
  checks: Record<string, 'up' | 'down'>;
}

@Injectable()
export class HealthService implements OnApplicationBootstrap {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: DependencyCheck[]) {}

  /**
   * Aquece as conexões (SDK da AWS, pool do banco) na subida: a primeira verificação costuma ser a
   * mais lenta e, sem isso, o primeiro /health/ready poderia estourar o limite e responder 503.
   * Se uma dependência estiver fora do ar, o serviço sobe do mesmo jeito e o ready informa.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.ready();
  }

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
