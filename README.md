# Wagering Processor ("Processador de apostas")

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`
e `ROLLBACK`) vindas de provedores de jogos, por HTTP e por fila (SQS). O saldo permanece correto
quando as mensagens chegam duplicadas, fora de ordem ou ao mesmo tempo, mesmo com várias
instâncias da aplicação.

As decisões de arquitetura, os trade-offs e as limitações estão em
[ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

Bun 1.x, TypeScript em modo estrito, NestJS, PostgreSQL 16, MikroORM 6, AWS SQS (LocalStack) e
Docker Compose.

## Pré-requisitos

- Bun 1.x
- Docker com Docker Compose

## Subindo o ambiente

~~~bash
bun install
docker compose up -d      # PostgreSQL e LocalStack; as filas são criadas na inicialização
bun run migrate:up        # aplica as migrations
bun run start             # API em http://localhost:3000
~~~

O `start` também liga, no mesmo processo, o publicador da outbox, o consumidor da fila de
transações e o worker de referências pendentes. Para conferir:

~~~bash
curl -s localhost:3000/health/ready
~~~

A resposta esperada é `{"status":"ready","checks":{"postgres":"up","sqs":"up"}}`. Para encerrar,
use `Ctrl + C` (encerramento ordenado). Para zerar os dados: `docker compose down -v`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação |
| `bun run dev` | Sobe a aplicação e reinicia a cada alteração |
| `bun run typecheck` | Verifica os tipos (`tsc --noEmit`) |
| `bun test` | Roda todos os testes |
| `bun run test:unit` | Testes unitários (não precisam do Docker) |
| `bun run test:integration` | Integração com PostgreSQL e LocalStack reais |
| `bun run test:processes` | Processos de verdade: 3 instâncias, `kill -9` com reinício e SIGTERM (2 a 3 minutos) |
| `bun run migrate:up` | Aplica as migrations pendentes |
| `bun run migrate:down` | Reverte a última migration |
| `bun run migrate:pending` | Lista as migrations pendentes |

Os testes de integração e de processos precisam de `docker compose up -d`. O ledger não aceita
`TRUNCATE`, então os testes criam carteiras novas em vez de limpar o banco.

## Configuração

Todas as variáveis são opcionais: os padrões já funcionam com o `docker-compose.yml`. Há um
exemplo em `.env.example`.

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint do SQS (LocalStack) |
| `AWS_REGION` | `us-east-1` | Região |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test` | Credenciais do LocalStack |
| `TRANSACTIONS_QUEUE_NAME` | `wager-transactions.fifo` | Fila de entrada |
| `TRANSACTIONS_DLQ_NAME` | `wager-transactions-dlq.fifo` | Fila de mensagens mortas |
| `EVENTS_QUEUE_NAME` | `wager-events.fifo` | Fila de eventos publicados |
| `SQS_MAX_RECEIVES` | `5` | Recebimentos antes de mandar à DLQ |
| `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE` | `500`, `20` | Ritmo e tamanho do lote do publicador |
| `PENDING_REFERENCE_POLL_MS`, `PENDING_REFERENCE_BATCH_SIZE` | `1000`, `20` | Ritmo e lote do worker de referências |
| `OUTBOX_WORKER_ENABLED`, `SQS_CONSUMER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | ligados (desligados sob `bun test`) | Liga ou desliga cada worker |

## API

| Método e rota | Descrição | Respostas |
|---|---|---|
| `POST /wallets` | Cria a carteira (e o crédito de abertura, se o saldo for maior que zero) | 201; 409 (já existe); 400 |
| `GET /wallets/:id` | Consulta a carteira | 200; 404 |
| `GET /wallets/:id/ledger?cursor=&limit=` | Ledger paginado por cursor opaco (limite padrão 50, máximo 200) | 200; 400; 404 |
| `POST /wallets/:id/reconciliation` | Compara o saldo guardado com o ledger. Não corrige nada | 200 (`consistent` indica o resultado); 404 |
| `POST /wagering/transactions` | Submete uma transação. Exige o header `Idempotency-Key` | 201 processada; 200 replay; 202 aguardando referência; 422 rejeitada (com `failureCode`); 409 conflito de idempotência; 400; 404; 503 (com `Retry-After`) |
| `GET /wagering/transactions/:id` | Consulta por id | 200; 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor | 200; 404 |
| `GET /health/live`, `GET /health/ready` | Liveness e readiness (PostgreSQL e SQS) | 200; 503 |
| `GET /metrics` | Métricas em formato Prometheus | 200 |

Os valores monetários são sempre `{ "amount": "25.00", "currency": "BRL" }`, com o `amount` como
string de duas casas. Toda resposta traz `X-Correlation-Id`.

### Fila de transações

A fila `wager-transactions.fifo` recebe mensagens do tipo `WagerTransactionRequested`, que usam o
mesmo caso de uso da API:

~~~json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-24T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
~~~

### Eventos publicados

Em `wager-events.fifo`: `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged` (só quando o saldo muda) e `WagerTransactionPendingReference`.

## Verificação manual

Com o ambiente de pé, em outro terminal:

~~~bash
PLAYER=$(bun -e "console.log(crypto.randomUUID())")
WALLET=$(curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | sed 's/.*"id":"\([^"]*\)".*/\1/')

bet() { # $1 = id externo, $2 = valor
  curl -s -w '  -> HTTP %{http_code}\n' -X POST localhost:3000/wagering/transactions \
    -H 'content-type: application/json' -H "Idempotency-Key: demo:$1" \
    -d "{\"providerId\":\"demo\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"$2\",\"currency\":\"BRL\"}}"
}
~~~

**Idempotência.** O mesmo pedido enviado três vezes debita uma só vez. O primeiro envio devolve
201 e os outros dois devolvem 200 com `"idempotentReplay":true`. A mesma chave com valor diferente
devolve 409.

~~~bash
for i in 1 2 3; do bet aposta-1 25.00; done
bet aposta-1 30.00
curl -s localhost:3000/wallets/$WALLET
~~~

**Concorrência.** Com saldo de 75,00, duas apostas simultâneas de 50,00: uma é aceita (201) e a
outra é rejeitada (422), e o saldo final é 25,00.

~~~bash
bet a 50.00 & bet b 50.00 & wait
curl -s localhost:3000/wallets/$WALLET
~~~

**Reversão fora de ordem.** Um `REFUND` que chega antes da aposta fica pendente (202). Quando a
aposta chega, o worker o aplica.

~~~bash
curl -s -w '  -> HTTP %{http_code}\n' -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo:refund-1' \
  -d "{\"providerId\":\"demo\",\"externalTransactionId\":\"refund-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r2\",\"gameId\":\"g1\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"aposta-2\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo:aposta-2' \
  -d "{\"providerId\":\"demo\",\"externalTransactionId\":\"aposta-2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r2\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}" > /dev/null
sleep 6
curl -s localhost:3000/wagering/transactions/$(curl -s localhost:3000/providers/demo/wagering/transactions/refund-1 | sed 's/.*"id":"\([^"]*\)".*/\1/')
~~~

O `REFUND` deve aparecer com `"status":"PROCESSED"`.

## Estrutura

~~~text
src/
  wallet/           carteira e ledger (domain, application, presentation)
  wagering/         transações, reversões, outbox e inbox
  shared/           Money, eventos de integração, portas e erros de domínio
  infrastructure/   banco, migrations, SQS, workers, métricas e HTTP
  health/           liveness e readiness
test/
  integration/      PostgreSQL e LocalStack reais
  process/          processos de verdade (kill -9, SIGTERM, 3 instâncias)
infra/localstack/   criação das filas na inicialização
~~~
