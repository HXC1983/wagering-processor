import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsSettings {
  endpoint: string;
  region: string;
  accountId: string;
  eventsQueueName: string;
}

/** Padrões para LocalStack. Em AWS real, defina SQS_ENDPOINT, as credenciais e EVENTS_QUEUE_URL. */
export function sqsSettings(): SqsSettings {
  return {
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
    accountId: process.env.AWS_ACCOUNT_ID ?? '000000000000',
    eventsQueueName: process.env.EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
  };
}

export function createSqsClient(settings: SqsSettings = sqsSettings()): SQSClient {
  return new SQSClient({
    region: settings.region,
    endpoint: settings.endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

/** URL em formato de caminho (path-style): não depende de DNS especial do LocalStack. */
export function queueUrlFor(settings: SqsSettings, queueName: string): string {
  return `${settings.endpoint}/${settings.accountId}/${queueName}`;
}

export function eventsQueueUrl(settings: SqsSettings = sqsSettings()): string {
  return process.env.EVENTS_QUEUE_URL ?? queueUrlFor(settings, settings.eventsQueueName);
}
