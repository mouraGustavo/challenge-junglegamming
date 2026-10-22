# Arquitetura

## Visão geral

A aplicação recebe operações de apostas por HTTP ou SQS. As duas entradas
chamam o mesmo `FinancialService`, para não manter regras diferentes em cada
caminho.

Usei um único projeto, com a API e o worker executados em processos separados.
O worker recebe mensagens, publica eventos e tenta novamente as operações que
dependem de uma referência. O Compose sobe três APIs e três workers para testar
a concorrência entre instâncias.

## Dinheiro

`Money` guarda o valor em centavos usando `bigint`. Por exemplo, `25.50` fica
armazenado internamente como `2550n`. Como o desafio trabalha com duas casas
decimais e só precisa de soma, subtração e comparação, essa representação foi
suficiente e evitou adicionar uma biblioteca decimal.

Os valores entram e saem como strings. O banco usa `NUMERIC`, e o MikroORM
devolve esses campos como strings. Dinheiro não passa por `number`, `Number`
ou `parseFloat`. Contagens, versões e tempos podem usar `number` normalmente.

Valores com zero, uma ou duas casas são normalizados para duas casas na saída.
Mais de duas casas são rejeitadas, sem arredondamento automático. Entradas
negativas, vazias, com espaços, notação científica, NaN ou Infinity também são
rejeitadas. O limite é de 28 dígitos inteiros e dois decimais. Operações internas
podem representar valores negativos, como a diferença de uma reconciliação.

O domínio permite moedas diferentes e impede operações entre elas. A API aceita
apenas BRL, conforme a simplificação permitida no desafio. `Money` é imutável:
uma soma ou subtração devolve outro objeto.

## Domínio e persistência

Escolhi MikroORM, que era a opção preferencial do enunciado. As classes de
domínio não importam NestJS nem o ORM. Elas têm construtores privados, métodos
de criação e `rehydrate`, que reconstrói o estado salvo sem repetir transições.

Os registros de persistência ficam separados dessas classes. Usei `EntitySchema`
para fazer o mapeamento e `DecimalType('string')` nos valores monetários.

As migrations são SQL versionado, com `up` e `down`, executado pelo MikroORM.
Não uso sincronização automática de schema. A tabela `schema_migrations`
registra o que já foi aplicado. O lock usado pelo runner é apenas para impedir
migrations simultâneas; ele não participa das operações financeiras.

O banco também protege as regras, sem depender apenas do TypeScript:

- Uma wallet por jogador e moeda.
- Saldo não negativo, valores finitos e no máximo duas casas decimais.
- Unicidade da chave de idempotência e da identidade externa do provedor.
- No máximo um lançamento por transação e wallet, e uma OPENING por wallet.
- Uma reversão processada por referência e tipo de reversão.
- Unicidade de consumerName/messageId na inbox.
- Chaves estrangeiras para manter wallet, jogador e moeda compatíveis.
- Cálculo correto entre saldo anterior, movimento e saldo posterior no ledger.

Usei `NUMERIC` sem escala fixa no tipo da coluna e validei a escala com `CHECK`.
Isso evita que o banco arredonde uma entrada com casas extras antes de validá-la.
Triggers impedem UPDATE, DELETE e TRUNCATE do ledger. O usuário do banco local
é administrativo para facilitar o setup; em produção, a aplicação deveria ter
permissões mais restritas.

## Transações e concorrência

O processamento usa `EntityManager.transactional()` e `SELECT FOR UPDATE` na
wallet. Enquanto uma operação está alterando aquela wallet, outra operação da
mesma wallet espera. Wallets diferentes podem ser processadas em paralelo.

Wallet, transação, ledger, inbox e outbox são confirmados juntos. Se a gravação
de qualquer parte falhar, tudo volta ao estado anterior. Os flushes dentro do
caso de uso servem para respeitar a ordem das chaves estrangeiras; não são commits.

O lock tem timeout de 3s, os comandos financeiros têm timeout de 10s e o pool
tem até dez conexões por instância, com espera de até 15s por conexão. Disputas
de unicidade, deadlocks e falhas de serialização permitem até três execuções,
sempre em uma transação nova após o rollback.

## Idempotência

A `Idempotency-Key` do header é obrigatória e tem escopo global. A sugestão é
usar `providerId:externalTransactionId`.

Para comparar os pedidos, calculo SHA-256 de um JSON UTF-8 com as chaves
ordenadas recursivamente. Entram no hash: providerId, externalTransactionId,
playerId, walletId, roundId, gameId, kind, money e referenceExternalTransactionId.
O dinheiro é normalizado antes do hash, UUIDs ficam em minúsculas e referência
ausente vira null. Header e dados de transporte ficam de fora.

Mesma chave e mesmo conteúdo devolvem o resultado salvo, incluindo o saldo
observado no processamento original. Mesma chave com outro conteúdo gera
`IDEMPOTENCY_CONFLICT`. Reusar a identidade externa com outra chave gera
`EXTERNAL_TRANSACTION_CONFLICT`. Os dois conflitos retornam HTTP 409.

A inbox tem uma verificação adicional: seu hash combina o hash de negócio com
a chave de idempotência. Assim, alterar a chave no mesmo messageId também é um
conflito. Não há cache em memória garantindo idempotência.

## Regras e interpretações

- A wallet começa na versão 1. Saldo inicial positivo gera OPENING e um crédito
  no ledger, sem incrementar a versão de novo. Saldo inicial zero não gera crédito.
- OPENING é interna e não pode ser enviada por HTTP ou SQS.
- Operações que movimentam saldo exigem valor positivo. LOSS aceita zero e não
  altera saldo, versão ou ledger, mas termina como PROCESSED e gera evento.
- BET não aceita referência. WIN e LOSS podem referenciar uma BET; se fizerem
  isso, a referência também precisa ser validada.
- REFUND referencia BET; ROLLBACK referencia BET, WIN ou REFUND. A reversão é
  integral e exige mesmo provedor, jogador, wallet, moeda e rodada.
- A restrição de reversão é por tipo. REFUND e ROLLBACK da mesma BET podem
  coexistir, seguindo a leitura adotada do enunciado.
- PROCESSED, REJECTED e FAILED são terminais. Uma reversão cria outra transação;
  ela não altera o histórico da operação original.

Os principais códigos de falha financeira são:

| Código | Motivo |
|---|---|
| INSUFFICIENT_FUNDS | Aposta sem saldo suficiente |
| REVERSAL_INSUFFICIENT_FUNDS | Débito de reversão deixaria saldo negativo |
| INVALID_REFERENCE | Tipo, valor ou identidade da referência incompatível |
| REFERENCE_NOT_PROCESSED | A referência terminou sem ser processada |
| REFERENCE_NOT_FOUND | Esgotaram as tentativas de aguardar a referência |
| REVERSAL_ALREADY_PROCESSED | A referência já recebeu aquela reversão |
| INFRASTRUCTURE_RETRY_EXHAUSTED | O processamento por SQS esgotou suas tentativas |

`INVALID_MONEY`, `INVALID_AMOUNT` e `CURRENCY_MISMATCH` identificam problemas
de valor ou moeda. `INVALID_TRANSACTION_STATE` indica uma transição indevida.
Payload inválido e conflito de identidade podem ser recusados antes de aceitar
a operação; nem todo erro cria uma transação REJECTED. Por exemplo, playerId
incompatível com a wallet retorna 400 sem inserir uma transação financeira.

No HTTP, uso 201 para criar wallet, 200 para operação processada, 202 para
pendência, 400 para contrato inválido, 404 para recurso ausente, 409 para
conflito, 422 para rejeição financeira, 500 para FAILED e 503 para falha
transitória. Consultar uma transação rejeitada retorna 200, com seu estado no corpo.

## Mensageria

O consumidor SQS valida o envelope e chama o mesmo caso de uso da API. A inbox
é identificada por consumerName/messageId. O ack, feito com DeleteMessage,
só acontece depois do commit.

Rejeições financeiras são persistidas e recebem ack. Mensagens inválidas,
wallets inexistentes e conflitos de identidade vão para a DLQ. Falhas de
infraestrutura recebem novas tentativas, com espera de 2, 4, 8 e 16 segundos.
No quinto recebimento, o consumidor tenta salvar FAILED e encaminha a mensagem
à DLQ. Se o banco continuar indisponível, o comando na DLQ preserva a auditoria.

A mensagem é enviada à DLQ antes de ser apagada da origem. Pode haver duplicação
se o processo morrer entre essas chamadas. Um replay de FAILED também tenta
encaminhar à DLQ, para não perder essa etapa. Falha no ack de uma operação já
confirmada não muda seu resultado financeiro.

A visibilidade é de 60s e é renovada a cada 15s durante o processamento. Na
parada, o worker não inicia novas recepções, mas aguarda o long poll em curso
terminar. Ele espera até 10s, com timeout da chamada de 15s. Se chegar uma
mensagem durante a parada, sua visibilidade é devolvida. O trabalho em andamento
termina antes de fechar as conexões.

### Publicação da outbox

O evento é salvo na transação financeira e publicado depois por outro processo.
Cada publisher busca uma linha com `FOR UPDATE SKIP LOCKED`. Isso permite que
outros publishers busquem linhas diferentes.

Mantive o lock durante o envio ao SQS, com timeout de 3s. Isso ocupa uma conexão
enquanto envia, mas foi uma escolha simples para evitar um mecanismo adicional
de reserva e expiração de mensagens.

Se o processo morrer depois do envio e antes de marcar a publicação, a linha
continua pendente. O próximo envio mantém o mesmo eventId. Por isso, consumidores
dos eventos precisam deduplicar esse ID de forma persistente. A deduplicação
FIFO ajuda, mas não substitui essa proteção. Falhas de envio têm backoff de 1s
até 60s; eventos da outbox não são descartados por esgotamento de tentativas.

### Referências fora de ordem

Referências ausentes ou ainda não concluídas deixam a operação em
PENDING_REFERENCE. O worker busca até dez pendências vencidas, bloqueia wallet
e transação e confere novamente o estado e a agenda antes de aplicar as regras.

São até dez tentativas, com espera crescente de 1s até 60s: aproximadamente
cinco minutos, mais atrasos de processamento ou indisponibilidade. Escolhi esse
limite para a demonstração local. Ao esgotá-lo, a operação é rejeitada com
REFERENCE_NOT_FOUND e gera um evento de rejeição, sem ledger.

Reenviar o pedido não zera as tentativas nem antecipa a agenda. Erros de banco
desfazem a tentativa e não aumentam a contagem. Retries que continuam pendentes
não criam novos eventos de pendência. Ao terminar, o resultado da transação é
atualizado; o resultado da inbox continua representando o aceite da mensagem.
Os eventos da retomada usam o ID da transação como correlationId e causationId.

## Consultas e reconciliação

O ledger usa cursor em base64url com walletId e ID da última entrada. A ordem
é por createdAt e ID. A comparação de timestamps acontece no banco para não
perder precisão. O cursor não é uma forma de autorização.

A reconciliação segura o mesmo lock da wallet enquanto compara saldo e soma
do ledger. Isso evita comparar dados de momentos diferentes durante uma
operação concorrente. Uma divergência aparece na resposta, no log e na métrica;
o sistema não corrige o saldo automaticamente.

## Docker, métricas e testes

API, worker e setup usam a mesma imagem Bun. O setup aplica migrations e cria
as filas antes das aplicações. As portas das APIs são 3001 a 3003; as dos
workers são 9101 a 9103, publicadas somente em localhost. O Compose permite
até 90s para encerrar os processos.

O cliente SQS usa o endpoint configurado, porque as URLs anunciadas pelo
LocalStack podem conter localhost e precisam funcionar também nos containers.

As métricas ficam em `/metrics`, em formato Prometheus. Contadores e histograma
de latência são por processo e reiniciam com ele. Status das transações,
pendências da outbox e idade do evento pendente mais antigo vêm do banco
compartilhado; essas métricas não devem ser somadas entre instâncias. Sem banco,
database_up fica em zero e as métricas que dependem dele são omitidas.

Os logs são JSON, com os IDs de contexto disponíveis, sem registrar montantes
ou payloads financeiros completos. Não uso IDs de wallet ou jogador como
labels das métricas, para não criar uma quantidade crescente de séries.

Os testes usam PostgreSQL e SQS reais, com bancos, filas e containers próprios.
Além dos testes de domínio, há testes de atomicidade, duplicação, reversões,
referências pendentes e concorrência entre três processos. Fixtures de teste
pausam o processo nas janelas de commit/ack e envio/marcação; o Docker envia
SIGKILL e outro processo recupera o trabalho. Também há testes de SIGTERM e
reinício. Essas barreiras não existem na API nem no worker de produção.

## Autenticação e limites

Não implementei autenticação completa, conforme permitido no desafio. Há uma
`ProviderIdentityPort` com adapter local que não autentica. Para integrar um
IdP externo, esse adapter validaria o JWT e vincularia o provedor às claims.
Não há tabela local de senhas. Os endpoints de health ficam abertos.

PostgreSQL tem volume persistente. O LocalStack local não tem persistência
configurada; a aplicação não oferece recuperação para perda dos dados do
broker. Reiniciar apenas as aplicações mantém o estado do banco e das filas.

Não implementei partidas dobradas, dashboard, tracing ou teste de carga.
O foco foi cobrir os requisitos obrigatórios e conseguir explicar as decisões.
