import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { jsonLog } from '../../shared/infrastructure/logger';
import { OutboxRelay } from '../../wagering/application/outbox-relay';

/** Sob `bun test` o worker fica desligado, a menos que OUTBOX_WORKER_ENABLED=true. */
function isWorkerEnabled(): boolean {
  const flag = process.env.OUTBOX_WORKER_ENABLED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'test';
}

@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private cancelSleep: (() => void) | undefined;

  constructor(@Inject(OutboxRelay) private readonly relay: OutboxRelay) {}

  onApplicationBootstrap(): void {
    if (!isWorkerEnabled()) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  /** SIGTERM: para de pegar lotes novos e conclui o lote em andamento. */
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.cancelSleep?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const pollMs = Number(process.env.OUTBOX_POLL_MS ?? 500);
    while (this.running) {
      let delay = pollMs;
      try {
        const result = await this.relay.runOnce();
        if (result.claimed >= this.relay.batchSize) {
          delay = 0; // ainda há fila: próximo lote sem esperar
        }
      } catch (error) {
        jsonLog('error', 'outbox relay failed', {
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
