import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export interface DependencyCheck {
  readonly name: string;
  /** Lança erro se a dependência não estiver alcançável. */
  check(): Promise<void>;
}

const TIMEOUT_MS = 2_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: sem resposta em ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class PostgresCheck implements DependencyCheck {
  readonly name = 'postgres';

  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await withTimeout(this.orm.em.getConnection().execute('select 1'), TIMEOUT_MS, 'postgres');
  }
}

export class SqsCheck implements DependencyCheck {
  readonly name = 'sqs';

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async check(): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
  }
}
