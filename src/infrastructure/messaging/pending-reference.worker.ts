import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { jsonLog } from '../../shared/infrastructure/logger';
import { ReprocessPendingReferencesUseCase } from '../../wagering/application/reprocess-pending-references.use-case';

/** Sob `bun test` o worker fica desligado, a menos que PENDING_REFERENCE_WORKER_ENABLED=true. */
function isWorkerEnabled(): boolean {
  const flag = process.env.PENDING_REFERENCE_WORKER_ENABLED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'test';
}

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private cancelSleep: (() => void) | undefined;

  constructor(
    @Inject(ReprocessPendingReferencesUseCase) private readonly useCase: ReprocessPendingReferencesUseCase,
  ) {}

  onApplicationBootstrap(): void {
    if (!isWorkerEnabled()) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  /** SIGTERM: para de pegar candidatas novas e conclui a que está em andamento. */
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.cancelSleep?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const pollMs = Number(process.env.PENDING_REFERENCE_POLL_MS ?? 1_000);
    while (this.running) {
      let delay = pollMs;
      try {
        const result = await this.useCase.runOnce();
        if (result.examined >= this.useCase.batchSize) {
          delay = 0; // ainda há fila: próximo lote sem esperar
        }
      } catch (error) {
        jsonLog('error', 'pending reference worker failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        delay = Math.max(pollMs, 1_000);
      }
      if (delay > 0 && this.running) {
        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.cancelSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
