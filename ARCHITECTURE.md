# Arquitetura

Este documento registra as decisões de arquitetura, os motivos, as alternativas consideradas e as
limitações conhecidas. O código é a fonte da verdade; aqui está o porquê.

## 1. Visão geral

Um **monólito modular** em NestJS, escalável horizontalmente: várias instâncias do mesmo serviço
compartilham o mesmo PostgreSQL e as mesmas filas SQS. Há dois módulos de negócio, `wallet`
(carteira e ledger) e `wagering` (transações, reversões, outbox e inbox), e cada um segue quatro
camadas:

| Camada | Responsabilidade | Depende de |
|---|---|---|
| `domain` | Regras e invariantes, em TypeScript puro (sem NestJS, ORM ou SQL) | nada |
| `application` | Casos de uso e portas (interfaces) | `domain` |
| `infrastructure` | Adaptadores: MikroORM, SQS, workers, métricas, HTTP | `application` e `domain` |
| `presentation` | Controllers HTTP | `application` |

As dependências apontam para dentro. O mesmo caso de uso atende as duas entradas (HTTP e fila), e
os eventos saem pela outbox:

~~~mermaid
flowchart LR
  P["Provedor"] -->|HTTP| API["API"]
  TQ[("wager-transactions.fifo")] --> CO["Consumidor SQS"]
  API --> UC["Caso de uso"]
  CO --> UC
  PW["Worker de referências pendentes"] --> UC
  UC -->|mesma transação SQL| DB[("PostgreSQL: saldo, ledger, inbox, outbox")]
  DB --> RL["Relay da outbox"]
  RL --> EV[("wager-events.fifo")]
  CO -.->|erro permanente| DLQ[("DLQ")]
~~~

**Por que monólito, e não microsserviços.** As garantias financeiras (saldo, ledger, idempotência e
evento) dependem de uma única transação no PostgreSQL. Separar saldo e ledger em serviços
distintos trocaria essa garantia por sagas e consistência eventual, que são mais complexas e não
trazem ganho para este escopo. A escalabilidade vem de rodar várias instâncias, o que os testes
com processos reais verificam.

## 2. Escolhas de stack

- **Bun, TypeScript estrito e NestJS**, como pedido. Os casos de uso são classes comuns,
  registradas no Nest por `useFactory`, com `@Inject` e tokens explícitos. Isso mantém a camada de
  aplicação independente do framework e evita depender de `emitDecoratorMetadata`, que no Bun tem
  relatos de falha de injeção de dependência.
- **MikroORM 6.x.** É o ORM preferencial do enunciado e oferece `EntityManager.transactional()`,
  `LockMode` e Unit of Work. A série 7.x já existe, mas fixei a 6.x, que é estável e cuja API
  conheço; migrar fica como trabalho futuro.
- **Mapeamento por `EntitySchema`, sem decorators.** O domínio não conhece o ORM: as classes de
  domínio têm construtor privado e `rehydrate`, e mappers convertem de e para as linhas.
- **Migrations em SQL puro**, versionadas, reversíveis (`up` e `down`) e transacionais, registradas
  em lista explícita e executadas por um script próprio (`bun run migrate:up`). O SQL puro é
  necessário porque CHECKs, índices parciais e triggers não saem do gerador automático, e o script
  próprio evita depender de um loader de TypeScript no CLI do MikroORM sob o Bun.
- **IDs:** UUID v4 gerado pela aplicação (os exemplos do enunciado usam v7; não há efeito funcional).
- **Relógio:** as datas vêm do relógio da aplicação, e não do banco. Veja as limitações.

## 3. Dinheiro (`Money`)

- Valor interno em **centavos como `bigint`**: exato, sem ponto flutuante e sem dependência. O teste
  com 9007199254740993,00 mostra a diferença para `number`.
- Entrada e saída só como string canônica `^(0|[1-9]\d*)\.\d{2}$` (escala fixa de duas casas, sem
  sinal e sem zeros à esquerda). A forma canônica mantém estável o hash de idempotência. `NaN`,
  `Infinity`, notação científica, string vazia, mais de duas casas e números JSON são recusados.
- Como mais de duas casas são recusadas, **não há arredondamento**: soma e subtração são exatas.
- Negativos só nascem de operações (`subtract`, `negate`), nunca da entrada. É assim que a carteira
  detecta saldo insuficiente (`isNegative`).
- Moeda: três letras maiúsculas. O modelo é multi-moeda (conflito de moeda é erro de domínio e
  rejeição de negócio), mas os testes usam principalmente BRL.
- **Persistência:** colunas separadas, `numeric(19,2)` para o valor e `char(3)` para a moeda. O ORM
  trata o valor como string, e a reidratação usa `Money.from`. Nenhum tipo monetário do ORM entra
  no domínio.

## 4. Schema do banco

As garantias estão no schema, e não só no código. Tabelas: `wallets`, `wager_transactions`,
`wallet_ledger_entries`, `inbox_messages`, `outbox_messages` e `schema_migrations`.

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; saldos do ledger também |
| Uma carteira por jogador e moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` |
| Referência resolvida por provedor | `UNIQUE (provider_id, external_transaction_id)` |
| Uma única reversão por referência | índice único parcial em `reference_transaction_id` (status processado, tipo `REFUND` ou `ROLLBACK`) |
| Um lançamento por carteira e transação | `UNIQUE (wallet_id, transaction_id)` |
| Aritmética do lançamento | `CHECK`: `balance_after = balance_before ± amount`, conforme o sentido |
| Ledger imutável | triggers que recusam `UPDATE`, `DELETE` e `TRUNCATE` |
| Estados terminais imutáveis | trigger que recusa `UPDATE` em transação `PROCESSED`, `REJECTED` ou `FAILED`, e qualquer `DELETE` |
| Paginação estável | coluna `seq` (identity) com índice `(wallet_id, seq)` |
| Consultas do worker e da outbox | índices parciais para `PENDING_REFERENCE` e para mensagens não publicadas |

Consequência prática: o ledger não aceita `TRUNCATE`, então os testes criam carteiras novas em vez
de limpar o banco. O que o schema não consegue impor (que o saldo guardado seja a soma do ledger)
é garantido pela gravação atômica e verificado pela reconciliação e pelos testes.

## 5. Concorrência

A unidade de concorrência é a `walletId`.

**Estratégia: lock pessimista por carteira.** Cada requisição abre uma transação e lê a carteira com
`SELECT ... FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`) **antes de qualquer outro acesso**. Requisições
da mesma carteira formam fila no banco, e carteiras diferentes seguem em paralelo (não há lock
global). A restrição `CHECK (balance >= 0)` é a segunda linha de defesa.

**Ordem dos locks.** A carteira é travada antes de qualquer `INSERT` que a referencie por chave
estrangeira. O PostgreSQL pega um lock fraco (`FOR KEY SHARE`) na linha da carteira ao verificar
uma FK; se duas requisições o fizessem e depois pedissem `FOR UPDATE`, haveria deadlock. O worker de
referências pendentes segue a mesma ordem: lê os candidatos sem lock, trava a carteira e só então
relê a transação já travada.

**Alternativas consideradas**

- *Optimistic locking com retry:* sob disputa na mesma carteira (a "hot wallet") gera retries em
  cascata, e o resultado depende de limites de tentativas.
- *`UPDATE` condicional atômico (`WHERE balance >= x`):* resolve o saldo, mas ledger, idempotência
  e eventos continuariam precisando de coordenação.
- O lock foi escolhido por ser simples de provar correto e por funcionar com qualquer número de
  instâncias. O custo é a serialização por carteira: o throughput de uma carteira é limitado pela
  duração de uma transação curta.

**`version`.** Começa em 1 e sobe apenas quando o saldo muda. Não é usado como token de optimistic
locking (a estratégia é o lock); acompanha os eventos como `walletVersion`.

**Cenário obrigatório** (100,00 e duas apostas simultâneas de 80,00): exatamente uma `PROCESSED`, a
outra `REJECTED` por saldo insuficiente, saldo final 20,00, um único débito. Está coberto por testes
dentro do mesmo processo, por instâncias separadas e por três processos de verdade.

## 6. Idempotência

- O header `Idempotency-Key` é obrigatório e é a fonte da verdade. A convenção recomendada é
  `{providerId}:{externalTransactionId}`.
- `payloadHash` = SHA-256 (hexadecimal) do **JSON canônico** (chaves ordenadas em todos os níveis,
  campos `undefined` omitidos, sem espaços) de: `providerId`, `externalTransactionId`, `playerId`,
  `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. O header e os
  metadados de transporte ficam fora do hash.
- Mesma chave e mesmo hash: **replay**. Devolve o resultado original, com o saldo observado na época
  (guardado em `resulting_balance`, inclusive nas rejeições), e `idempotentReplay: true`.
- Mesma chave com hash diferente: **conflito** (409), que nunca é tratado como replay.
- Como a carteira é travada antes da consulta da chave, quem chega depois enxerga o commit de quem
  chegou antes. Se a mesma chave chegar para carteiras diferentes (e, portanto, sem passar pelo mesmo
  lock), a constraint única do banco decide, e o caso de uso repete a consulta uma vez: encontra a
  transação existente (replay ou conflito).

~~~mermaid
sequenceDiagram
  participant P as Provedor
  participant A as API ou consumidor SQS
  participant U as Caso de uso
  participant D as PostgreSQL
  P->>A: transação com Idempotency-Key
  A->>U: comando validado
  U->>D: BEGIN e SELECT da carteira FOR UPDATE
  D-->>U: carteira travada
  U->>D: busca a chave de idempotência
  alt chave já existe
    U-->>A: replay (200) ou conflito (409)
  else chave nova
    U->>U: aplica as regras no domínio
    U->>D: INSERT transação, UPDATE saldo, INSERT ledger e INSERT outbox
    U->>D: COMMIT
    U-->>A: 201, 422 ou 202
  end
  A-->>P: resposta
~~~

## 7. Regras de negócio e reversões

| Tipo | Efeito no saldo | Ledger |
|---|---|---|
| `BET` | débito; rejeitada se o saldo for insuficiente | 1 lançamento `DEBIT` |
| `WIN` | crédito | 1 lançamento `CREDIT` |
| `LOSS` | nenhum (aceita valor zero) | nenhum |
| `REFUND` | crédito (reverte uma `BET`) | 1 lançamento `CREDIT` |
| `ROLLBACK` | inverso da referência (reverte `BET`, `WIN` ou `REFUND`) | 1 lançamento invertido |

`OPENING` é interno (crédito de abertura da carteira) e não pode ser submetido pela API nem pela
fila.

**Reversões.** As regras 1 a 6 são uma função pura (`evaluateReversal`), avaliada em ordem; a regra 7 é
verificada ao aplicar o lançamento (`TransactionApplier`). A primeira que falha decide, e uma rejeição
nunca altera o saldo:

| Ordem | Verificação | `failureCode` |
|---|---|---|
| 1 | referência ausente (ou ainda pendente) | aguarda (`PENDING_REFERENCE`) |
| 2 | mesmo provedor, jogador, carteira, rodada e moeda | `REFERENCE_MISMATCH` |
| 3 | tipo permitido para a referência | `REFERENCE_KIND_NOT_ALLOWED` |
| 4 | a referência foi processada | `REFERENCE_NOT_PROCESSED` |
| 5 | valor igual ao da referência | `AMOUNT_MISMATCH` |
| 6 | a referência ainda não foi revertida | `ALREADY_REVERSED` |
| 7 | o débito de reversão não deixa o saldo negativo | `REVERSAL_WOULD_OVERDRAW` |

**Interpretação adicional (documentada, como o enunciado pede):** o enunciado diz que uma referência
não pode ser revertida duas vezes "pelo mesmo tipo de operação". Apliquei algo mais estrito: **no
máximo uma reversão de qualquer tipo por referência**, imposta por índice único parcial. Isso evita
um crédito em dobro (por exemplo, `REFUND` e `ROLLBACK` da mesma `BET`).

**Referências fora de ordem.** Se a referência ainda não existe, a transação é gravada como
`PENDING_REFERENCE` (resposta 202), com o evento `WagerTransactionPendingReference`. Um worker
agendado a reprocessa com espera exponencial de 1 s, 2 s, 4 s e assim por diante, com teto de
60 s, e **no máximo 8 tentativas (cerca de 3 minutos)**. A justificativa: a reordenação de mensagens
costuma durar segundos, então três minutos cobrem a janela realista sem deixar a pendência aberta
para sempre. Esgotado o limite, a transação é rejeitada com `REFERENCE_NOT_FOUND` e o evento
`WagerTransactionRejected` é publicado. Os limites ficam em constantes (`REFERENCE_RETRY`), fáceis de
ajustar. Uma transação rejeitada é terminal: se a referência chegar depois, o provedor precisa
reenviar a reversão com uma chave nova.

~~~mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> PROCESSED : regra aplicada
  PENDING --> REJECTED : regra de negócio violada
  PENDING --> FAILED : erro permanente
  PENDING --> PENDING_REFERENCE : referência ausente
  PENDING_REFERENCE --> PENDING_REFERENCE : nova tentativa com espera
  PENDING_REFERENCE --> PROCESSED : referência chegou
  PENDING_REFERENCE --> REJECTED : regra violada ou limite esgotado
  PENDING_REFERENCE --> FAILED : erro permanente
  PROCESSED --> [*]
  REJECTED --> [*]
  FAILED --> [*]
~~~

Na prática, `PENDING` existe só em memória: a transação é gravada já no estado final ou como
`PENDING_REFERENCE`.

## 8. Outbox, inbox e SQS

**Outbox transacional.** Saldo, ledger, transação, inbox (se a entrada for a fila) e o evento de
integração entram na **mesma transação SQL**. Nada é publicado dentro da requisição: um relay
publica depois do commit.

- O relay reserva um lote com `FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE`), de
  modo que vários publicadores (várias instâncias) nunca pegam as mesmas linhas.
- Publica no SQS e marca como publicada **na mesma transação**: se o processo morrer entre uma coisa
  e outra, a transação é desfeita e outra instância publica o lote. O evento pode sair duas vezes,
  mas nunca se perde.
- Se a publicação falhar, a mensagem ganha `attempts` e `next_attempt_at` (1 s, 2 s, 4 s... até
  5 min) e só volta a ser reservada quando vence.
- A fila de eventos é FIFO, com `MessageGroupId` igual à carteira e `MessageDeduplicationId` igual ao
  `eventId`. Isso é uma otimização: a segurança contra duplicatas é o consumidor ignorar um
  `eventId` repetido.

**Eventos** (envelope com `eventId`, `eventType`, `aggregateId` = carteira, `correlationId`,
`causationId`, `occurredAt`, `version` e `data`, com valores monetários como `MoneyProps`):

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | rejeição por regra de negócio |
| `WalletBalanceChanged` | somente quando o saldo muda (inclusive a abertura da carteira) |
| `WagerTransactionPendingReference` | referência ausente |

**Inbox e consumidor.** A mensagem `WagerTransactionRequested` é traduzida no mesmo comando da API e
processada pelo mesmo caso de uso. A linha do inbox `(consumidor, messageId)` é gravada na mesma
transação do saldo, então "recebi" e "processei" nascem juntos. A mensagem só é apagada da fila
**depois do commit**. Para cada mensagem:

| Situação | O que acontece |
|---|---|
| Resultado registrado (processada, rejeitada por regra ou replay) | `ack` |
| Mensagem malformada, ou erro de domínio sem registro auditável (carteira inexistente, conflito) | DLQ imediata |
| Qualquer outro erro (infraestrutura) | retry com backoff (1 s, 2 s, 4 s... até 60 s) pela visibilidade da mensagem; DLQ no 5º recebimento |

O redrive do próprio SQS (também com limite 5) fica como rede de segurança. Em `SIGTERM`, o
consumidor conclui a mensagem em andamento e devolve as demais do lote (visibilidade 0). Em um
retry, o resto do lote também volta para a fila, para preservar a ordem do grupo FIFO.

## 9. Taxonomia de `failureCode`

Toda rejeição carrega um `failureCode` estável. A última coluna indica o que o provedor deve fazer.

| Código | Quando | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | saldo menor que o valor da aposta | aposta recusada; só uma nova aposta, com nova chave |
| `CURRENCY_MISMATCH` | moeda diferente da carteira | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | o jogador não é o dono da carteira | corrigir o payload |
| `REFERENCE_NOT_FOUND` | a referência não apareceu dentro do limite de tentativas | enviar a referência e reenviar a reversão com nova chave |
| `REFERENCE_MISMATCH` | a referência é de outro provedor, jogador, carteira, rodada ou moeda | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência não permitido | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada ou falhou | desistir: não há o que reverter |
| `AMOUNT_MISMATCH` | valor diferente do da referência | corrigir o payload |
| `ALREADY_REVERSED` | a referência já foi revertida | desistir: já está resolvido |
| `REVERSAL_WOULD_OVERDRAW` | a reversão deixaria o saldo negativo | intervenção operacional (o saldo já foi gasto) |

`REFERENCE_TIMEOUT` e `INFRASTRUCTURE_FAILURE`, e o estado `FAILED`, existem no modelo como
reserva, mas nenhum caminho de código os produz hoje (veja as limitações).

## 10. API HTTP: mapeamento de status

| Situação | Status | Observação |
|---|---|---|
| Processada pela primeira vez, ou carteira criada | 201 | |
| Replay idempotente | 200 | `idempotentReplay: true` |
| Aceita, aguardando a referência | 202 | `PENDING_REFERENCE` |
| Rejeição por regra de negócio | 422 | corpo com `status: REJECTED` e `failureCode`; o replay de uma rejeição também devolve 422 |
| Payload inválido (campos, dinheiro, UUID, header ausente, cursor) | 400 | `{ "error": { "code", "message" } }` |
| Recurso inexistente | 404 | |
| Conflito de idempotência ou carteira duplicada | 409 | |
| Falha transitória de infraestrutura (banco indisponível, deadlock) | 503 | com `Retry-After: 1`: o provedor sabe que pode reenviar |
| Erro inesperado | 500 | |

O mapeamento é o mesmo em todos os endpoints (um único filtro de exceções). Dinheiro só é aceito
como string.

**Ledger paginado.** Cursor opaco (base64url de um JSON com versão e `seq`), limite padrão 50 e
máximo 200, ordenado por `seq`. A busca lê `limit + 1` linhas para saber se há próxima página. O
cursor por `seq` é seguro **dentro de uma carteira**, porque os lançamentos nascem sob o lock da
carteira: a ordem de `seq` é a ordem de commit. Não seria seguro em escala global.

**Reconciliação.** Uma única instrução SQL lê o saldo guardado e a soma do ledger (um retrato
consistente). Divergência **nunca é corrigida**: gera um log de nível `error`, incrementa
`reconciliation_divergences_total` e devolve `consistent: false`.

## 11. Autenticação

Não foi implementada: não pontua e não deve competir com correção financeira, concorrência e
idempotência. Existe um **ponto de extensão explícito**: um `AuthGuard` sem efeito, registrado
globalmente (`APP_GUARD`). Os endpoints de health e de métricas ficam abertos, e as mensagens da
fila são tratadas como canal interno confiável, mas a identidade do provedor nelas continua sujeita
às validações de domínio.

**Desenho que adotaria:** integrar um Identity Provider externo (Keycloak ou Zitadel) por OIDC; cada
provedor se autentica por `client_credentials`; o guard valida o token e compara o `providerId` do
token com o do payload (e com o prefixo da chave de idempotência); autorização por escopo. Não haveria
tabela de usuários nem hash de senha na aplicação.

Sem autenticação, quem chama pode se declarar qualquer provedor: é uma limitação conhecida.

## 12. Observabilidade

- **Logs estruturados em JSON**, com `correlationId`, `messageId`, `transactionId`, `walletId` e
  `providerId` quando existem. Nunca registram corpo da requisição, valores monetários nem
  parâmetros de consulta. Cada requisição recebe um `X-Correlation-Id` (reaproveitado do cliente, se
  válido, ou gerado), que acompanha o caso de uso e chega ao evento na outbox.
- **Métricas** em `GET /metrics` (formato Prometheus, em memória, por instância):

| Exigido | Métrica |
|---|---|
| Transações por status | `wager_transactions_total{status,kind}` |
| Duplicatas | `duplicates_detected_total{source=idempotency_key\|inbox}` |
| Retries | `retries_total{component=outbox_publish\|sqs_consumer\|pending_reference}` |
| Mensagens em DLQ | `dlq_messages_total{reason=permanent\|retries-exhausted}` |
| Conflitos de lock | `lock_conflicts_total{kind=wallet_wait\|idempotency_race}` e `wallet_lock_wait_ms` |
| Atraso da outbox | `outbox_publish_delay_ms`, `outbox_pending_messages` e `outbox_oldest_pending_age_seconds` |
| Latência | `transaction_processing_ms{outcome}` |
| Reconciliação | `reconciliation_divergences_total` |

- **Health:** `GET /health/live` indica processo vivo; `GET /health/ready` verifica o PostgreSQL e o
  SQS (limite de 2 s por dependência) e responde 503 com `Retry-After` se algum falhar. As conexões
  são aquecidas na subida para o primeiro readiness não estourar o limite.
- **Encerramento ordenado (`SIGTERM`):** os workers concluem o trabalho em andamento, o consumidor
  devolve as mensagens que não começou e o pool do banco é fechado.

## 13. Estratégia de testes

| Camada | O que cobre | Comando |
|---|---|---|
| Unitários (domínio e casos de uso) | `Money`, `Wallet`, ledger, transações, política de reversão, cursor, hash, métricas, handler da fila | `bun run test:unit` |
| Integração (PostgreSQL e LocalStack reais) | casos de uso, HTTP, outbox, inbox, consumidor, ledger e reconciliação, observabilidade | `bun run test:integration` |
| Processos de verdade | 3 processos simultâneos, `kill -9` com reinício, morte antes de publicar, `SIGTERM` | `bun run test:processes` |

Os oito cenários de concorrência exigidos:

| # | Cenário | Onde está |
|---|---|---|
| 1 | a mesma aposta 50 vezes em paralelo gera um único débito | integração e processos |
| 2 | operações disputando o saldo da mesma carteira | integração e processos |
| 3 | carteiras distintas em paralelo | integração |
| 4 | três ou mais instâncias simultâneas | integração (3 pools) e processos (3 processos) |
| 5 | worker morto depois do commit e antes do `ack` | integração com a fila real |
| 6 | dois publicadores sobre a mesma outbox | integração |
| 7 | `REFUND` ou `ROLLBACK` antes da referência | integração |
| 8 | reinício do serviço, com consistência final | processos (`kill -9` no meio de 200 apostas) |

**Invariante verificado ao final dos cenários:** `saldo da carteira == saldo reconstruído pelo ledger`.

No teste `kill -9`, o ponto da morte varia a cada execução (o teste imprime quantas chamadas foram
interrompidas), então as afirmações valem em qualquer intercalação: o provedor reenvia tudo com as
mesmas chaves, e cada aposta aparece exatamente uma vez.

## 14. Limitações e trade-offs conhecidos

- **Métricas em memória, por instância:** não são agregadas entre instâncias e se perdem no reinício.
  Um coletor externo faria a soma.
- **"Conflito de lock" é uma aproximação:** o PostgreSQL não informa que uma requisição esperou.
  Conto como conflito toda espera pela carteira acima de 25 ms e toda corrida de idempotência que
  exigiu nova tentativa.
- **A outbox não tem limite máximo de tentativas:** uma mensagem que nunca consegue ser publicada fica
  pendente (com espera de até 5 min entre tentativas) até o broker voltar. O atraso é visível nas
  métricas.
- **A publicação no SQS acontece dentro da transação do relay:** mantém as linhas reservadas durante a
  chamada de rede; o lote pequeno (20) limita o efeito.
- **Relógio da aplicação:** vencimentos de espera e datas vêm do relógio de cada instância. Um desvio
  grande entre instâncias adiantaria ou atrasaria as tentativas, sem afetar o saldo.
- **`FAILED` sem produtor:** o estado, o `failureCode INFRASTRUCTURE_FAILURE` e `REFERENCE_TIMEOUT`
  estão modelados, mas nenhum caminho os usa. Falhas de infraestrutura hoje viram 503 (HTTP) ou retry e
  DLQ (fila).
- **Mensagem rejeitada por erro de domínio vai para a DLQ** (sem registro auditável), enquanto uma
  rejeição por regra de negócio fica registrada como `REJECTED`. A fronteira é uma interpretação
  minha do enunciado.
- **Hot wallet:** o throughput de uma única carteira é limitado pela duração de uma transação curta.
  Escalar uma carteira específica exigiria outra estratégia (por exemplo, contas auxiliares).
- **Testes de processo na mesma máquina e no mesmo banco:** não provam máquinas diferentes, nem
  falhas de rede ou do próprio PostgreSQL. O LocalStack também não reproduz todas as garantias do SQS
  real (por exemplo, a janela de deduplicação do FIFO).
- **Sem autenticação** (veja a seção 11), sem TLS e sem limite de taxa. As credenciais do
  `docker-compose.yml` são apenas de desenvolvimento.
- **Sem teste de carga** (`bun run test:load`), sem OpenTelemetry e sem ledger de partidas dobradas
  (diferenciais opcionais).
- **Reversão parcial** está fora de escopo, como o enunciado define.

## 15. Com mais tempo

1. Um coletor de métricas externo e alertas sobre `outbox_oldest_pending_age_seconds`.
2. Limite máximo de tentativas na outbox, com uma tabela de mensagens mortas.
3. Autenticação por OIDC, como descrito na seção 11.
4. Teste de carga, com a metodologia e a análise honesta do resultado.
5. Testes de caos (queda do PostgreSQL e partição de rede) e execução em máquinas separadas.
6. Estudar o limite de throughput da carteira quente e alternativas de particionamento.

## 16. Processo de desenvolvimento

Este projeto foi desenvolvido com o apoio de um assistente de IA (Claude, da Anthropic), usado como parceiro de programação ao longo dos três dias.

**Como a IA foi usada:** discussão da arquitetura e dos trade-offs, geração de código e testes, revisão e redação da documentação, e explicações dos conceitos (concorrência, idempotência, outbox) à medida que apareciam.

**O que eu fiz:** defini o escopo e as prioridades (por exemplo, deixar a autenticação de fora e documentar o desenho), montei o ambiente, executei e li os testes, corrigi problemas, fiz os commits e revisei as decisões. Estudei cada parte para conseguir explicá-la e defendê-la.

**Cuidado com o resultado:** a corretude não depende de confiança no assistente. Ela é verificada por testes automatizados (unitários, de integração com PostgreSQL e SQS reais e de processos com falhas injetadas) e por restrições no próprio banco de dados.

Registro isto de forma explícita por transparência.
