# Distributed Wagering Processor

API financeira em TypeScript estrito, Bun, NestJS, MikroORM, PostgreSQL e SQS
local. A mesma operação de aplicação atende HTTP e SQS. O saldo, o ledger e os
eventos são confirmados na mesma transação SQL.

O enunciado original está preservado em [CHALLENGE.md](CHALLENGE.md).
Decisões, interpretações e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Ferramentas

- Docker com Compose, usando Linux containers.
- Bun 1.x para desenvolvimento e testes no host. A imagem fixa Bun 1.4.3.
- Git e um editor.

PostgreSQL e LocalStack rodam em containers. Não é necessária conta AWS,
Java, PHP, Composer, instalação local do banco ou AWS CLI global.

## Subir três APIs e três workers

Na raiz do repositório:

```powershell
docker compose up -d --wait postgres localstack
docker compose build setup
docker compose --profile app up -d --wait
docker compose --profile app ps
```

O serviço `setup` aplica migrations e inicializa as filas antes das aplicações.
Repetir o setup não apaga dados nem recria filas. A imagem é a mesma para API,
worker e setup. Cada worker executa consumidor, publisher e referências.

| Serviço | Endereço no host |
|---|---|
| APIs 1 / 2 / 3 | http://localhost:3001 / :3002 / :3003 |
| Métricas das APIs | `/metrics` em cada API |
| Health/métricas dos workers | http://localhost:9101 / :9102 / :9103 |
| PostgreSQL | localhost:5433, banco `wagering`, usuário/senha `challenge` |
| LocalStack | http://localhost:4566 |

Portas publicadas somente no loopback. Credenciais acima são de desenvolvimento.

```powershell
Invoke-RestMethod http://localhost:3001/health/ready
Invoke-WebRequest http://localhost:3001/metrics
docker compose logs --tail 80 api-1 worker-1
```

Para parar aplicações e manter infraestrutura/dados:

```powershell
docker compose stop api-1 api-2 api-3 worker-1 worker-2 worker-3
```

O PostgreSQL tem volume persistente. Não use `down -v` para um reinício normal.
LocalStack nesta configuração não tem volume persistente; após recriá-lo,
execute o setup novamente. A outbox PostgreSQL permite recuperar eventos ainda
não marcados como publicados, mas mensagens já entregues ao broker dependem da
durabilidade dele. Essa configuração local não simula recuperação de disco SQS.

## Desenvolvimento no host

Pare as aplicações do perfil `app` se quiser executar apenas uma API/worker no
host. Mantenha PostgreSQL e LocalStack disponíveis:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run db:migrate
bun run infra:init
bun run start
```

Em outro terminal, `bun run worker`. A API local usa porta 3000 e o worker
expõe health/métricas em 9100. Ctrl+C conclui trabalho em andamento e encerra.

Variáveis opcionais: `HOST`, `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME`, `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `METRICS_PORT`, `SQS_INPUT_QUEUE`, `SQS_DLQ_QUEUE`,
`SQS_EVENTS_QUEUE`. Valores locais padrão estão em `src/config.ts`.

O build usa TypeScript com metadados de decorators e Bun executa o resultado.
`bun run dev` é um atalho de desenvolvimento; os comandos de validação usam build.

## Exercício HTTP de cinco minutos

Escolha a API do Compose; para modo host, troque por porta 3000:

```powershell
$base = 'http://localhost:3001'
$player = [guid]::NewGuid().ToString()
$body = @{ playerId = $player; initialBalance = @{ amount = '100.00'; currency = 'BRL' } } | ConvertTo-Json
$wallet = Invoke-RestMethod "$base/wallets" -Method Post -ContentType 'application/json' -Body $body
$external = [guid]::NewGuid().ToString()
$bet = @{ providerId = 'provider-a'; externalTransactionId = $external; playerId = $player; walletId = $wallet.id; roundId = 'round-1'; gameId = 'game-1'; kind = 'BET'; money = @{ amount = '25.00'; currency = 'BRL' } } | ConvertTo-Json
$headers = @{ 'Idempotency-Key' = "provider-a:$external" }
Invoke-RestMethod "$base/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $headers -Body $bet
Invoke-RestMethod "$base/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $headers -Body $bet
Invoke-RestMethod "$base/wallets/$($wallet.id)"
Invoke-RestMethod "$base/wallets/$($wallet.id)/ledger?limit=50" | ConvertTo-Json -Depth 8
Invoke-RestMethod "$base/wallets/$($wallet.id)/reconciliation" -Method Post | ConvertTo-Json -Depth 5
```

Esperado: saldo 75.00, version 2, mesmo transactionId nas duas respostas,
`idempotentReplay: true` na segunda; um crédito OPENING e um débito BET;
reconciliação consistente. Repetir a chave com valor diferente resulta em 409.

## Endpoints e contratos

| Método / caminho | Função |
|---|---|
| POST `/wallets` | Abre wallet, com OPENING auditável quando saldo > zero |
| GET `/wallets/:walletId` | Saldo e versão |
| GET `/wallets/:walletId/ledger?cursor=...&limit=50` | Ledger crescente, cursor opaco, limite 1–100 |
| POST `/wagering/transactions` | BET, WIN, LOSS, REFUND ou ROLLBACK |
| GET `/wagering/transactions/:transactionId` | Estado e resultado persistido |
| GET `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por identidade externa |
| POST `/wallets/:walletId/reconciliation` | Compara saldo e soma do ledger, sem corrigir |
| GET `/health/live` | Processo vivo |
| GET `/health/ready` | PostgreSQL e SQS alcançáveis |
| GET `/metrics` | Métricas em formato Prometheus |

Dinheiro entra e sai como `{ "amount": "25.00", "currency": "BRL" }`.
Não envie números JSON no campo amount. O domínio suporta moedas diferentes,
mas a API limita o desafio a BRL. Referências de REFUND/ROLLBACK são os IDs
externos do provedor. A Idempotency-Key do header é obrigatória e global;
recomenda-se `providerId:externalTransactionId`. OPENING é somente interno.

HTTP: criação 201; transação processada 200; pendência 202; contrato inválido
400; recurso ausente 404; conflito 409; rejeição financeira 422; falha terminal
500; indisponibilidade transitória 503. GET de uma transação rejeitada retorna
200 com status/failureCode. Identidade incompatível entre player e wallet é
contrato inválido antes da aceitação, sem criar transação financeira.

## Mensageria

Filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
`wager-events.fifo`. O contrato completo está no enunciado; exemplos executáveis
com SDK estão em `tests/integration/messaging.test.ts`.

O consumidor confirma somente depois do commit; inbox deduplica por
consumerName/messageId. Rejeição financeira recebe ack. Envelope inválido e
conflito vão à DLQ. Infraestrutura tem retry de visibilidade até cinco entregas.
Referências ausentes têm agenda persistente, backoff e limite de dez tentativas.
Publishers usam SKIP LOCKED e reenvio com eventId estável; o consumidor externo
deve deduplicar esse ID. FIFO ajuda no transporte, mas o PostgreSQL garante as
invariantes financeiras.

## Testes

Com infraestrutura disponível e dependências instaladas no host:

```powershell
bun run test:unit
bun run test:integration
bun run test:distributed
```

`test:distributed` constrói a imagem e usa a rede Compose
`challenge-junglegamming_default`. Seus containers, banco e filas têm UUIDs
próprios e são removidos no final. Não usa o banco `wagering` para os cenários.
Para rede/imagem customizadas, use `TEST_DOCKER_NETWORK`/`TEST_DOCKER_IMAGE`.

`bun run test:all` executa typecheck, build, unidade, integração e distribuídos.
`bun run test` é somente a suíte rápida de unidade.

| Suíte | O que comprova |
|---|---|
| Unidade | Money, wallet, transições, contratos, eventos, inbox e outbox |
| Schema | Up/down/up, constraints, precisão, imutabilidade e rollback |
| Financeira | 50 replays paralelos, disputa 80+80 contra 100, reversões, resultado original, reconciliação |
| HTTP | Rotas, códigos, health, métricas e lock timeout |
| Mensageria | Broker real, redelivery, retry/DLQ, referências, publishers concorrentes, recuperação e parada |
| Distribuída | Três processos reais, SIGKILL após commit/antes de ack, SIGKILL após envio/antes de marcar, SIGTERM e reinício |

A invariante final é saldo igual à soma assinada do ledger. Barreiras de crash
existem apenas nas fixtures de teste; não são endpoints nem flags de produção.
Não há alegação de benchmark ou meta de throughput.

## Observabilidade e limites

Contadores de duplicatas, conflitos, retries, DLQ, divergências e histograma de
latência são por processo e reiniciam com ele. Consulte todas as instâncias.
As gauges de status/outbox vêm do PostgreSQL compartilhado; não some essas
gauges entre instâncias, pois representam o mesmo banco. Não há labels por
wallet/player/transação, evitando cardinalidade crescente.

Logs JSON carregam IDs de correlação/mensagem/transação/wallet/provedor quando
disponíveis, sem registrar valores ou payloads financeiros completos. Logs de
framework/startup podem não ter identidade de domínio associada.

Autenticação completa foi omitida conforme permitido no enunciado. Há uma
ProviderIdentityPort com adapter local no-op; em produção, um IdP externo
validaria JWT e vincularia claims ao provider. Health permanece aberto.
Não há double-entry, dashboards, tracing, frontend ou mecanismos de produção
além dos necessários às garantias exigidas.