# Bloco 03 — processamento financeiro e HTTP

Implementa os endpoints financeiros do enunciado e um FinancialService
compartilhável com SQS. Eventos são gravados na outbox junto com a transação;
o envio ao broker e workers ficam para o próximo bloco.

## Validar no PowerShell

Na raiz `C:\Workspaces\challenge-junglegamming`, com Docker disponível:

```powershell
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
```

`test:integration` executa schema, financeiro e HTTP. Cada suíte usa um banco
temporário próprio. O banco principal não recebe dados dessas suítes.
O teste HTTP também exige SQS local alcançável. Não é necessário instalar
dependências novas nem mudar o lockfile para este bloco.

Para executar a API no banco principal, aplique a migration se ainda não fez:

```powershell
bun run db:migrate
bun run start
```

## Exercício manual — cerca de 15 minutos

Com a API em execução, abra outro PowerShell na raiz do projeto:

```powershell
$base = 'http://localhost:3000'
$player = [guid]::NewGuid().ToString()
$walletBody = @{ playerId = $player; initialBalance = @{ amount = '100.00'; currency = 'BRL' } } | ConvertTo-Json
$wallet = Invoke-RestMethod "$base/wallets" -Method Post -ContentType 'application/json' -Body $walletBody
$external = [guid]::NewGuid().ToString()
$bet = @{ providerId = 'provider-a'; externalTransactionId = $external; playerId = $player; walletId = $wallet.id; roundId = 'round-1'; gameId = 'game-1'; kind = 'BET'; money = @{ amount = '25.00'; currency = 'BRL' } } | ConvertTo-Json
$headers = @{ 'Idempotency-Key' = "provider-a:$external" }
Invoke-RestMethod "$base/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $headers -Body $bet | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/wagering/transactions" -Method Post -ContentType 'application/json' -Headers $headers -Body $bet | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/wallets/$($wallet.id)" | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/wallets/$($wallet.id)/ledger?limit=50" | ConvertTo-Json -Depth 8
Invoke-RestMethod "$base/wallets/$($wallet.id)/reconciliation" -Method Post | ConvertTo-Json -Depth 5
```

Esperado: aposta PROCESSED, replay com mesmo transactionId e saldo 75.00,
idempotentReplay=true na segunda resposta; wallet version=2; ledger com
OPENING CREDIT 100 e BET DEBIT 25; reconciliação consistent=true.

Não faça commit cego de tudo: o staging anterior do usuário foi preservado.
Revise `git status` e os arquivos antes de criar um checkpoint.

## Limites desta etapa

- PENDING_REFERENCE é persistida, mas ainda não tem worker de retomada.
- Não há publicação de eventos no SQS, consumidor, DLQ nem shutdown de workers.
- Três processos e testes de crash/reinício ainda pertencem ao próximo bloco.
- Métricas e logs com contexto financeiro completo ainda serão acrescentados.
- ProviderIdentityPort está explícita; o adapter local não autentica provedores.
- `bun run test` continua sendo a suíte rápida de unidade; integração é explícita.
