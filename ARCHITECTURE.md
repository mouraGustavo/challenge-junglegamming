# Arquitetura — decisões e evolução

## Escopo implementado até o bloco 03

Base NestJS, health checks de PostgreSQL/SQS, filas locais, domínio financeiro,
mapeamento MikroORM, migration inicial, HTTP financeiro, caso de uso transacional
compartilhável, inbox transacional e eventos persistidos na outbox. Consumidor
SQS, publishers, worker de referências e observabilidade financeira completa
ainda serão implementados.

## Dinheiro

Money armazena centavos como `bigint`, mantém moeda e é imutável. Como o desafio
fixa escala 2 e só exige soma/subtração/comparação, inteiros são suficientes e
reduzem dependências. Esta escolha substitui a proposta inicial de decimal.js.
Nenhum valor monetário passa por `number`, `parseFloat` ou `Number`. Versões,
contagens, portas e durações podem usar `number`.

Entrada/JSON e PostgreSQL usam strings decimais. Entradas com 0, 1 ou 2 casas
são normalizadas para 2 na saída. Mais de 2 casas são rejeitadas, inclusive
`1.005`: não há arredondamento financeiro implícito. Entradas negativas,
expoentes e espaços são inválidos. `rehydrate` e operações internas aceitam
sinais para representar diferenças. Limite: 28 dígitos inteiros e 2 fracionários,
validado tanto pelo domínio quanto pelo banco. Overflow lança erro.

Moedas são identificadores ISO reconhecidos pelo ICU do runtime. O domínio
suporta, por exemplo, BRL e USD e rejeita operações entre moedas diferentes.
A futura API restringirá a operação a BRL, permitido pelo enunciado.

## Domínio e ORM

Money, Wallet, WagerTransaction e WalletLedgerEntry têm construtores privados,
factories e rehydrate. Rehydrate reconstrói estado, sem reaplicar transições.
O domínio não importa NestJS nem MikroORM. Datas expostas são cópias.

Os registros do ORM são DTOs de persistência, separados do domínio; por isso
não encapsulam transições financeiras. EntitySchema evita decorators e
acoplamento do domínio ao banco. DecimalType('string') mantém NUMERIC exato.
WalletRecord demonstra o caminho domínio → registro → domínio, inclusive para
valores maiores que Number.MAX_SAFE_INTEGER.

## Schema e migrations

Migrations são SQL versionado, com up/down, executado por um runner pequeno via
MikroORM. Cada execução é uma transação; a tabela schema_migrations registra o
histórico. Um advisory lock transacional coordena somente migrações simultâneas.
Operações financeiras nunca usarão esse lock de schema. Não há schema sync nem
geração automática de DDL em startup.

NUMERIC sem typmod, com CHECK de escala e magnitude, evita que NUMERIC(p,2)
arredonde um valor inválido antes da validação. CHECKs impedem saldo negativo,
valores não finitos e aritmética inválida do ledger. FKs compostas ligam wallet,
player e moeda, e impedem ledger de outra wallet/moeda para a transação.

UNIQUEs protegem player+moeda, idempotency key, provider+externalTransactionId,
transaction+wallet no ledger, uma OPENING por wallet e consumer+messageId na
inbox. Idempotency key tem escopo global: o header é a identidade exata;
recomenda-se provider:externalTransactionId para evitar colisões entre provedores.
Índice parcial restringe reversões PROCESSED por referência+kind; uma rejeição
não bloqueia uma futura tentativa com nova identidade.

Triggers proíbem UPDATE, DELETE e TRUNCATE do ledger, inclusive alterações
que manteriam o mesmo valor. Não há cascade de exclusão. Como em qualquer
PostgreSQL, o administrador pode alterar o schema; o usuário da aplicação em
produção não deve ser dono das tabelas. O usuário do Compose é administrativo
apenas para simplificar o ambiente do desafio.

As constraints não substituem o caso de uso: as mudanças de wallet, ledger,
transação, inbox e outbox precisarão ser efetuadas na mesma transação. O teste
deste bloco comprova rollback conjunto do armazenamento, ainda não o fluxo
HTTP/SQS completo. Reconciliação será usada para verificar o saldo contra o ledger.

## Interpretações do domínio

- OPENING é interno. A validação de entrada HTTP/SQS o impedirá externamente.
- Wallet abre em version 1, inclusive com saldo inicial positivo; OPENING registra
  esse crédito sem incrementar a versão de novo.
- Operações financeiras exigem valor positivo; wallet pode abrir com zero.
  LOSS aceita valor não negativo, sem produzir movimento ou ledger.
- WIN e LOSS podem referenciar BET. Se a referência é informada, ela será validada
  ou ficará pendente, assim como reversões. WIN pode ter valor diferente da BET.
- REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND. Valores de
  reversão são integrais, e provider/player/wallet/moeda/rodada devem coincidir.
- A proibição de repetição é por tipo: REFUND e ROLLBACK da mesma BET podem
  coexistir, conforme o texto. Não adicionamos exclusão entre os dois tipos.
- PROCESSED, REJECTED e FAILED são terminais. PENDING e PENDING_REFERENCE podem
  ir a estados terminais; PENDING_REFERENCE pode permanecer pendente no retry.
- Falta de saldo em BET: INSUFFICIENT_FUNDS. Débito de reversão sem saldo:
  REVERSAL_INSUFFICIENT_FUNDS. Falhas são códigos estáveis de domínio.

## Hash canônico

SHA-256 de JSON UTF-8 com chaves ordenadas recursivamente. Campos incluídos:
providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
money normalizado como amount/currency e referenceExternalTransactionId (null
quando ausente). Header, chave de idempotência e metadados de transporte ficam
fora. `25`, `25.0` e `25.00` têm a mesma representação monetária canônica.
O caso de uso persistirá esse hash e o resultado original para replay.

## Processamento financeiro — bloco 03

A unidade de concorrência é a wallet. FinancialService usa MikroORM
EntityManager.transactional e SELECT FOR UPDATE na linha da wallet. Não há
lock financeiro global. Lock timeout: 3s. Pool: até 10 conexões por instância,
com espera de aquisição de até 15s para acomodar bursts sem aumentar conexões.
Replays retornam o resultado salvo,
incluindo o saldo observado na execução original. Disputas de UNIQUE entre
wallets e deadlocks/serialization failures admitem até três execuções, sempre
em uma transação nova após rollback; a nova leitura classifica replay/conflito.

A chave de idempotência é global. Uma externalTransactionId já aceita pelo
provider com outra chave produz EXTERNAL_TRANSACTION_CONFLICT (409), mesmo
com payload igual. Mesma chave e payload divergente: IDEMPOTENCY_CONFLICT.
UUIDs são normalizados para minúsculas antes do hash.

As entradas são validadas antes da aceitação. Apenas BRL é exposta na API.
playerId incompatível com wallet é contrato inválido (400), não uma transação
financeira aceita; isso evita violar a FK composta e não cria wager/ledger.
BET não aceita referência; WIN/LOSS podem referenciar BET. Referência ausente
ou ainda não terminal produz PENDING_REFERENCE. Referência terminal rejeitada
produz REFERENCE_NOT_PROCESSED. Os retries agendados serão do próximo bloco;
um replay HTTP não tenta aplicar novamente uma pendência.

HTTP: criação 201; operação PROCESSED 200; REJECTED 422 com failureCode e
resultado persistido; pendência 202; payload inválido 400; recurso ausente 404;
conflito 409; indisponibilidade transitória classificada 503. Consultar uma
transação rejeitada usa GET 200 e informa status/failureCode no corpo.

Wallet, wager, ledger, inbox opcional e outbox são gravados na mesma transação.
Flushes intermediários garantem a ordem das FKs e não são commits. A inbox
salva hash de { hash: hash de negócio, idempotencyKey } para detectar alteração
da chave no mesmo messageId; correlationId e metadados não alteram esse hash.
Classes concretas de IntegrationEvent definem eventType/version. OPENING gera
crédito de ledger e eventos; LOSS gera WagerTransactionProcessed sem evento
de saldo. Nenhum evento é enviado ao broker neste bloco.

Paginação crescente por createdAt/id usa cursor base64url com identidade da
wallet e última entrada. O timestamp é comparado no banco para preservar sua
precisão. O cursor é opaco para o cliente, não é mecanismo de autorização.
Reconciliação segura o mesmo lock da wallet durante soma do ledger e leitura
de saldo, evitando divergência artificial por escrita concorrente. A resposta
expõe divergência sem corrigi-la; logs/métricas de divergência entram no bloco
de observabilidade.

Testes de integração usam bancos temporários próprios. A suíte financeira
exercita o caso de uso real com conexões concorrentes e falha injetada por
trigger na outbox. A suíte HTTP usa uma API Nest real, PostgreSQL e readiness
SQS. Essas provas ainda não substituem testes de três processos e crash/ack.

## Próximos blocos

O consumidor SQS fará ack só após commit. Outbox será publicada por worker após commit, com coordenação de
publishers e consumidores idempotentes. Pendências terão retry persistente e
limite documentado. Esses componentes e seus testes ainda não estão entregues.

## Autenticação

Não implementar IdP neste timebox: o enunciado aceita a decisão e não atribui
pontos a autenticação. O HTTP tem um ProviderIdentityPort explícito e adapter
de desenvolvimento no-op. Em produção, um adapter validaria JWT de um IdP externo e vincularia
as claims ao providerId, sem tabela local de senhas. Health ficará aberto e a
fila será canal interno confiável, mantendo validações de domínio.
