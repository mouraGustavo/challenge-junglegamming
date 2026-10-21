# Verificação — bloco 03

## Execução local em 21/10/2026

Verificado com Bun 1.4.3, PostgreSQL 17.4 e LocalStack 4.12.0 no PC do usuário.
Os comandos abaixo serão repetidos como gate final antes de considerar o
bloco concluído:

```powershell
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
```

A integração executa três suítes: schema, financeiro e HTTP. A suíte financeira
registra cada cenário como JSON e só passa se todos terminarem. Os bancos
temporários são removidos ao final. Nenhum dado de teste é enviado ao banco
principal.

O ensaio concorrente detectou timeout de aquisição de conexão sob burst de
50 requisições. O pool tinha 10 conexões e somente 3s de espera. Mantivemos 10
conexões e separamos os limites: aquisição até 15s, lock da wallet até 3s.
Timeouts de aquisição também são classificados como infraestrutura transitória.
O teste aguarda todos os 50 resultados antes de liberar o banco, inclusive
quando há falhas. Os cenários da suíte são sequenciais explícitos; os envios
dentro dos cenários de concorrência continuam paralelos. A revisão final
acrescentou independência entre wallets e HTTP 503 por lock timeout; conferir
seus resultados no gate final abaixo.

Ainda não validado neste bloco: consumidor/publisher reais, retry/DLQ, retomada
de referências, três processos e morte depois de commit/antes de ack. Os eventos
ficam persistidos na outbox e não são publicados por esta versão.

Gate final concluído: typecheck, build, 30 testes unitários e as três suítes de integração passaram. A suíte financeira incluiu 13 cenários, e HTTP comprovou 503 por lock timeout.
