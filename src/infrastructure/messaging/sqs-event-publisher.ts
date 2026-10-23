import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../wagering/application/outbox-ports';
import type { OutboxMessage } from '../../wagering/domain/outbox-message';

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // Ordem por carteira e deduplicação do broker são otimizações:
        // a garantia final é o consumidor ignorar eventId repetido.
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
