import { spawn } from 'bun';
import { sleep } from './wait';

export interface StartOptions {
  /** Worker da outbox (publicador). Desligado por padrão. */
  outbox?: boolean;
  /** Consumidor da fila de transações. Desligado por padrão. */
  consumer?: boolean;
  /** Worker de referências pendentes. Desligado por padrão. */
  pendingReference?: boolean;
  env?: Record<string, string>;
}

export interface AppProcess {
  readonly port: number;
  readonly baseUrl: string;
  /** Últimos ~20 mil caracteres de stdout e stderr (útil quando um teste falha). */
  logs(): string;
  hasExited(): boolean;
  exited(): Promise<number>;
  /** SIGKILL: o processo morre sem nenhuma chance de encerramento ordenado. */
  kill9(): Promise<void>;
  /** SIGTERM: encerramento ordenado. Informa se encerrou dentro do prazo. */
  terminate(timeoutMs?: number): Promise<{ exited: boolean; elapsedMs: number }>;
  /** Encerra o que ainda estiver de pé (limpeza dos testes). */
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

function collect(stream: ReadableStream<Uint8Array> | undefined, sink: { text: string }): void {
  if (!stream) {
    return;
  }
  const decoder = new TextDecoder();
  void (async () => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      sink.text = (sink.text + decoder.decode(value, { stream: true })).slice(-20_000);
    }
  })().catch(() => undefined);
}

async function waitReady(app: AppProcess, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.hasExited()) {
      throw new Error(`o processo encerrou antes de ficar pronto:\n${app.logs()}`);
    }
    try {
      const response = await fetch(`${app.baseUrl}/health/ready`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // ainda subindo
    }
    await sleep(250);
  }
  throw new Error(`timeout aguardando /health/ready:\n${app.logs()}`);
}

/** Sobe a aplicação inteira como um processo do sistema operacional, em uma porta livre. */
export async function startApp(options: StartOptions = {}): Promise<AppProcess> {
  const port = await freePort();
  const sink = { text: '' };

  const proc = spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'integration',
      PORT: String(port),
      OUTBOX_WORKER_ENABLED: String(options.outbox ?? false),
      SQS_CONSUMER_ENABLED: String(options.consumer ?? false),
      PENDING_REFERENCE_WORKER_ENABLED: String(options.pendingReference ?? false),
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  collect(proc.stdout as ReadableStream<Uint8Array> | undefined, sink);
  collect(proc.stderr as ReadableStream<Uint8Array> | undefined, sink);

  const app: AppProcess = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logs: () => sink.text,
    hasExited: () => proc.exitCode !== null || proc.signalCode !== null,
    exited: () => proc.exited,
    async kill9() {
      proc.kill('SIGKILL');
      await proc.exited;
    },
    async terminate(timeoutMs = 15_000) {
      const startedAt = Date.now();
      proc.kill('SIGTERM');
      const exited = await Promise.race([proc.exited.then(() => true), sleep(timeoutMs).then(() => false)]);
      return { exited, elapsedMs: Date.now() - startedAt };
    },
    async stop() {
      if (app.hasExited()) {
        return;
      }
      const result = await app.terminate(10_000);
      if (!result.exited) {
        await app.kill9();
      }
    },
  };

  try {
    await waitReady(app);
  } catch (error) {
    await app.stop();
    throw error;
  }
  return app;
}
