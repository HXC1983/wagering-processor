#!/bin/bash
set -euo pipefail

# Fila de mensagens mortas (DLQ)
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

DLQ_URL=$(awslocal sqs get-queue-url \
  --queue-name wager-transactions-dlq.fifo \
  --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# Fila principal, com redrive para a DLQ após 5 recebimentos
cat > /tmp/main-queue-attrs.json << JSON
{
  "FifoQueue": "true",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"
}
JSON

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes file:///tmp/main-queue-attrs.json
