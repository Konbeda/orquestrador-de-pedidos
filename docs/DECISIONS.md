# Decisões de arquitetura

Registro das decisões tomadas antes da implementação, com o motivo de cada uma.
Serve de base para o README final.

## Stack

| Peça | Escolha | Por quê |
|---|---|---|
| Framework | NestJS 12 (ESM) | Exigência do desafio |
| Banco | MongoDB + Mongoose | Pedido é um documento com itens aninhados; uma coleção principal, sem relações |
| Fila | BullMQ (Redis) | Fila de jobs dentro de um serviço: retry com backoff, dedup por `jobId` e métricas nativos |
| Serviço externo | Frankfurter (`api.frankfurter.dev/v1`) | Câmbio, gratuito, sem chave. Converte o total para `ENRICHMENT_TARGET_CURRENCY` |
| Validação HTTP | class-validator | Integração direta com o `ValidationPipe` e `@IsISO4217CurrencyCode()` |
| Validação de env | zod | App não sobe com configuração inválida |
| Testes | Vitest + Testcontainers + nock | Mongo/Redis reais nos testes de integração; Frankfurter nunca chamada de verdade nos testes |

**Alternativas consideradas:** RabbitMQ (DLQ nativa, mas retry com backoff manual; faria sentido entre serviços)
e Kafka (log de eventos, exagerado para o caso). Os pacotes `@nestjs/idempotency` e `@nestjs/resilience`
existem, mas estão em 0.0.x; a implementação própria mostra o mecanismo e não depende de API instável.

## Status do pedido

```
RECEIVED → ENRICHING → ENRICHED
                    ↘ FAILED_ENRICHMENT (com failure_reason)
```

Só existe `FAILED_ENRICHMENT` para falha; o motivo fica em `failure_reason`
(`UNSUPPORTED_CURRENCY`, `PROVIDER_UNAVAILABLE`, `PROVIDER_REJECTED`...) e `retryable` indica se pode ser reprocessado.

## Dinheiro

Somas e conversões em **centavos inteiros** (`money.ts`), para não acumular erro de ponto flutuante
(`0.1 * 3 = 0.30000000000000004`). Assume 2 casas decimais, o que cobre as moedas da Frankfurter.

## Domínio

`Order` (agregado) concentra a máquina de status e as regras de dinheiro, sem conhecer HTTP, Mongo ou BullMQ.
Transições inválidas lançam erros de domínio (`InvalidOrderTransitionError`, `OrderBeingProcessedError`,
`ReprocessNotAllowedError`), que a camada HTTP traduz para 409/422.

## Camadas (ports & adapters)

Casos de uso (`orders/application`) dependem só de **ports** (classes abstratas: `OrderRepository`,
`EnrichmentQueue`, `SupportedCurrencies`) e não importam Nest, Mongo ou BullMQ. Nos testes unitários, os ports
são **fakes em memória** (`test/fakes`) que imitam as garantias reais: índice único, lock otimista e dedup por `jobId`.
Os fakes também simulam corridas e Redis fora, cenários difíceis de reproduzir com infraestrutura real.

## Idempotência (3 camadas)

1. **Banco (fonte da verdade):** índice `unique` em `idempotency_keys` e em `order_id`.
   Inserções concorrentes iguais: só uma vence, a outra recebe duplicate key (E11000).
   `idempotency_keys` é um **array** (o pedido guarda todas as chaves já aplicadas, por causa da
   política `update`); índice unique sobre array no Mongo garante que nenhuma chave aparece em dois pedidos.
   A chave atual (última do array) é o `jobId`.
2. **Fila:** `jobId = idempotency_key`; o BullMQ ignora job repetido.
3. **Worker:** só enriquece se o status ainda permitir; job reentregue para pedido `ENRICHED` não faz nada.

| Situação | Resposta |
|---|---|
| Mesma `idempotency_key` | 200 + pedido existente, sem reenfileirar (exceto reparo, abaixo) |
| Mesma `idempotency_key` com **outro** `order_id` | 422: o cliente reaproveitou a chave para outra operação |
| Mesmo `order_id`, outra chave, `ORDER_DUPLICATE_POLICY=reject` (padrão) | 409 |
| Mesmo `order_id`, outra chave, `ORDER_DUPLICATE_POLICY=update` | Ver tabela abaixo |

**Corrida entre requisições:** as buscas por chave e por `order_id` são só o caminho rápido. Se duas requisições
passam juntas pelas buscas, o índice único recusa o insert da perdedora (`DuplicateOrderError`), e o caso de uso
**reavalia a requisição uma vez**, agora enxergando o pedido da vencedora (vira 200 duplicate ou 409).

**Consistência banco ↔ fila (sem outbox):** são duas gravações em dois sistemas sem transação, então sempre existe
uma janela em que a primeira deu certo e a segunda não. A ordem é **Mongo primeiro** (fonte da verdade), fila depois:
se falhar, sobra um *pedido sem job* (recuperável, o job é recriado a partir do pedido), nunca um *job sem pedido*
(o worker não teria o que processar). Enfileirar antes também abriria corrida no caminho feliz (worker pega o job
antes do insert terminar) e enfileiraria requisições que o índice único ainda iria recusar.

Defesas, da mais rápida para a mais lenta:
1. **Retry interno curto** do enqueue dentro da requisição (`ENQUEUE_RETRY_DELAYS_MS`, padrão 100/200/400 ms):
   cobre piscadas do Redis sem o cliente perceber. Antes de cada tentativa consulta `isAvailable()`: com a conexão
   sabidamente caída, desiste na hora em vez de dormir 700 ms à toa. As esperas só valem enquanto a fila parece de pé
   (Redis travado, comandos expirando). Custo aceito: uma queda curtíssima durante a requisição não é aproveitada;
   o pedido fica com a varredura (ou o retry do cliente).
2. **202 mesmo assim:** esgotadas as tentativas, o pedido já está salvo, então a resposta continua 202
   (`pendingEnqueue: true` vira log de warning). O 202 promete "recebi e vou processar", e a promessa vale por causa
   da varredura. Uma DLQ não serviria aqui: ela também mora no Redis, que é justamente o que caiu.
3. **Reparo no retry do cliente:** se o cliente reenviar a mesma chave, um pedido ainda `RECEIVED` é enfileirado
   na hora (seguro: a fila deduplica por `jobId`).
4. **Varredura de órfãos** (`EnqueueStaleOrders`): job agendado que enfileira pedidos `RECEIVED` parados há mais
   de alguns minutos. É a "DLQ" do enqueue, guardada no Mongo, que não caiu junto com o Redis.

Consequência: **Redis fora não derruba o recebimento**; a API segue aceitando pedidos e só o processamento atrasa.

**Lock otimista no update:** o update grava só se a `revision` no banco ainda for a que foi lida.
Duas atualizações simultâneas do mesmo pedido: a perdedora recebe 409 e deve tentar de novo.

Política `update` por status atual:

| Status | Ação |
|---|---|
| `RECEIVED` | Atualiza; o job na fila lê a versão nova |
| `ENRICHING` | 409 (worker está processando; evita corrida) |
| `ENRICHED` / `FAILED_ENRICHMENT` | Atualiza, volta para `RECEIVED`, reenfileira com `jobId` = nova chave |

Guarda `revision` e as `idempotency_keys` aplicadas. **Teto de revisões** (`MAX_ORDER_REVISIONS`, padrão 10):
o update que passaria do limite é recusado com 409 e o pedido não muda. Limita o tamanho do array de chaves
(documento e índice multikey não crescem sem fim) e quantas vezes um cliente com bug, ou hostil,
consegue devolver o pedido para a fila. As respostas da API expõem só `revision`, nunca o array de chaves. **Risco aceito:** sem versão no payload,
atualizações fora de ordem seguem *last write wins*. Em produção: exigir `version`/`updated_at` do cliente.

Em sistema com várias origens, o único correto seria `(source, order_id)`; aqui há uma origem só.

## Validação no recebimento

| Caso | Resposta | Persistência |
|---|---|---|
| Formato inválido (contrato) | 400 com `request_id` e erros | `webhook_rejections` (mascarado, TTL) |
| Moeda ISO válida mas não suportada | 202 | `orders` com `FAILED_ENRICHMENT` / `UNSUPPORTED_CURRENCY`, **não enfileira** |
| Body acima de `BODY_LIMIT` | 413 | Não grava o payload |
| Válido | 202 | `orders` com `RECEIVED` + enfileira |

Moedas suportadas: endpoint `/currencies` da Frankfurter com cache (TTL), fallback em `SUPPORTED_CURRENCIES_FALLBACK`.

## Auditoria de rejeições (LGPD)

Coleção `webhook_rejections`, separada de `orders`: `request_id`, `received_at`, `source`, `errors`,
`error_codes` normalizados, payload **com e-mail e nome mascarados**, `payload_hash` (SHA-256 do original).

- Base legal: exercício regular de direitos / legítimo interesse; minimização: dado pessoal mascarado.
- Retenção: índice TTL em `received_at` (`REJECTION_RETENTION_DAYS`, padrão 90).
- Logs da aplicação também nunca têm e-mail/nome completos (`redact` do pino + `maskPII()`).
- `request_id` em todas as requisições (header `x-request-id`, reaproveitado se o cliente mandar),
  propagado para logs e dados do job.

## Índices

| Coleção | Índice | Uso |
|---|---|---|
| `orders` | `idempotency_keys` unique (multikey) | Idempotência: nenhuma chave em dois pedidos |
| `orders` | `order_id` unique | Mesmo pedido com outra chave |
| `orders` | `{ status, queue_checked_at }` | Varredura de órfãos (o índice já entrega a ordem do `sort`) |
| `orders` | `{ status, failure.retryable, created_at: -1 }` | `GET /orders?status=` e varredura de reprocessamento |
| `webhook_rejections` | `request_id` unique | Consulta pontual do suporte |
| `webhook_rejections` | `{ source, received_at }` | "Rejeições do cliente X no período" |
| `webhook_rejections` | `received_at` TTL | Exportação por período + expurgo automático |

Sem índice em `errors`/`error_codes` por enquanto: coleção é muito mais escrita que lida.
`error_codes` já é gravado; o índice pode ser criado depois sem mudar código.

## Persistência (`MongoOrderRepository`)

- **Campos em snake_case** no banco (`order_id`, `idempotency_keys`, `unit_price`...), como o payload e a API;
  o domínio usa camelCase e o adapter traduz nos dois sentidos.
- **Lock otimista pelo filtro:** `updateOne({ _id, revision: esperada })`. `matchedCount = 0` com o documento
  existindo = alguém salvou antes → `ConcurrentUpdateError`. `versionKey` (`__v`) do Mongoose desligado: quem
  controla concorrência é a `revision` do domínio.
- **E11000 → `DuplicateOrderError`**, usando o `keyPattern` do erro para dizer qual índice recusou
  (`order_id` ou `idempotency_keys`). Vale também para o `update` (chave nova que já pertence a outro pedido).
- **`findById` estrito:** só aceita 24 hex; o Mongoose aceitaria qualquer texto de 12 caracteres como ObjectId.
- **Índices antes do tráfego:** o Mongoose cria índices em segundo plano. Sem o índice único pronto, duas requisições
  iguais podem gravar dois pedidos. O módulo precisa aguardar `model.init()` antes de aceitar requisições.

### Teste de contrato

Uma única suíte (`test/contracts/order-repository.contract.ts`) descreve o comportamento de qualquer
`OrderRepository` e roda **contra o fake (unit) e contra o Mongo real (integration)**. Os testes de casos de uso
confiam no fake; o contrato prova que o fake se comporta como o banco. Já pegou uma divergência: o `update` do fake
não recusava chave pertencente a outro pedido, e o índice único do Mongo recusa.

## Enriquecimento, retry e DLQ

O caso de uso `EnrichOrder` decide **o que aconteceu** e sinaliza com erros tipados; não conhece BullMQ.
O worker (adapter) traduz:

| Caso de uso | Quando | Pedido | Worker (BullMQ) |
|---|---|---|---|
| `{ outcome: 'enriched' }` | Sucesso | `ENRICHED` | Job concluído |
| `{ outcome: 'skipped' }` | Pedido já final ou inexistente (job repetido / fantasma) | Não muda | Job concluído |
| `RetryEnrichmentLater` | Erro temporário com tentativas sobrando | Fica `ENRICHING` | Relança: backoff exponencial |
| `EnrichmentFailed` | 4xx (já na 1ª tentativa) **ou** última tentativa | `FAILED_ENRICHMENT` + motivo | `UnrecoverableError`, job para a DLQ |
| `ExchangeProviderPaused` | Circuito aberto (checado antes de tocar no pedido) | Fica `RECEIVED` | `rateLimit` + `RateLimitError`: espera sem gastar tentativa |

- **Classificação:** `ProviderRejectedError` (4xx) → `PROVIDER_REJECTED`, não reprocessável;
  `ProviderUnavailableError` (timeout, 5xx) → `PROVIDER_UNAVAILABLE`, reprocessável;
  qualquer outro erro (nosso: bug, banco) → `INTERNAL_ERROR`, reprocessável. Os dois últimos só viram falha final
  na última tentativa.
- **`ENRICHING` é gravado antes de chamar o provedor**, para o update do cliente (política `update`) saber que o
  pedido está em processamento e responder 409 em vez de correr contra o worker.
- **Cliente atualizou entre a leitura e o `ENRICHING`** (lock otimista): `RetryEnrichmentLater`; a próxima tentativa
  lê os dados novos. Se era a última tentativa, o job falha com o pedido ainda `RECEIVED`, e a varredura o pega.
- **Moeda igual à de destino:** taxa 1, sem chamar o provedor (e sem depender do circuito).
- **Falha final relê o pedido do banco** antes de marcar `FAILED_ENRICHMENT`: a cópia local pode estar pela metade
  (ex.: completou mas o save falhou).
- **Lacuna conhecida:** se nem a falha consegue ser gravada (banco fora), o pedido fica `ENRICHING` para sempre; a
  varredura atual só olha `RECEIVED`. Fecharia com uma varredura de `ENRICHING` parados há muito tempo.

### Worker (`EnrichmentWorker` + `EnrichmentJobProcessor`)

O processor é puro (testado sem Redis) e traduz o resultado do caso de uso para o BullMQ; o worker só liga as peças.
Comportamentos do BullMQ 6 **conferidos com Redis real** nos testes de integração:

| Caso de uso | Processor | Efeito medido |
|---|---|---|
| `ExchangeProviderPaused` | `queue.rateLimit(CIRCUIT_RESET_TIMEOUT_MS)` + `RateLimitError` | Job volta para a fila **sem gastar tentativa** (4 pausas + sucesso com orçamento de 3) |
| `EnrichmentFailed` | Copia para `orders-enrichment-dlq` + `UnrecoverableError` | Não tenta de novo; DLQ com `jobId`, pedido, `request_id`, motivo, erro, tentativas, data |
| Temporário com tentativas | Relança | Backoff exponencial do job |
| Qualquer erro **na última tentativa** com o pedido ainda `RECEIVED` | `ReleaseJobForSweeper`; o worker **apaga o job falho** | O `jobId` fica livre e a varredura consegue reenfileirar |

- **Por que apagar o job falho:** o BullMQ guarda jobs falhos (`removeOnFail`, 7 dias) e o dedup por `jobId` ignoraria
  o enqueue da varredura. Acontece quando o cliente atualiza o pedido no meio, ou o banco oscila antes do `ENRICHING`.
- **`queue.rateLimit` e não `worker.rateLimit`:** o do worker está *deprecated* no BullMQ 6; o da fila pausa **todos**
  os workers de todas as instâncias de uma vez (o circuito aberto vale para todos).
- **Conexões:** o produtor falha rápido (webhook esperando); o worker reconecta indefinidamente
  (`maxRetriesPerRequest: null`, exigido pelo BullMQ na conexão bloqueante) para atravessar reinícios do Redis.
- **DLQ** é uma fila sem consumidor: registro do que falhou de vez, para inspeção e métricas. O pedido em
  `FAILED_ENRICHMENT` continua sendo a fonte da verdade; se a cópia na DLQ falhar, o job tenta de novo e a próxima
  execução vê o pedido final e encerra (a cópia é perdida, o estado do pedido não).
- **`WORKER_ENABLED`** (padrão `true`): a mesma imagem roda como API + worker ou só API. Em produção, API e workers
  escalam separados. No shutdown, o worker termina os jobs em andamento antes de sair.

## Produtor da fila: falhar rápido

Medido com Redis real (BullMQ 6 + ioredis 6), tempo de um `queue.add`:

| Cenário | Configuração padrão | Nosso adapter |
|---|---|---|
| Redis de pé | 4 ms | 1 ms |
| Redis travado (pausado: TCP aberto, sem resposta) | pendurado (> 15 s) | ~0,5 s (`REDIS_COMMAND_TIMEOUT_MS`) |
| Redis parado | pendurado (> 15 s) | ~1 ms |
| App subiu antes do Redis | pendurado (> 10 s) | ~1 ms |

O padrão pendura porque o ioredis guarda comandos numa *offline queue* até reconectar, e o BullMQ espera a
conexão ficar pronta antes de enviar qualquer comando (mesmo com a offline queue desligada). Pendurado, o webhook
ficaria esperando e o retry interno do `ReceiveOrder` nunca rodaria. O adapter (`BullMqEnrichmentQueue`):

1. Usa uma conexão ioredis própria com `enableOfflineQueue: false`, `maxRetriesPerRequest: 0` e
   `commandTimeout` (o único jeito de notar um Redis travado, que mantém o TCP aberto).
2. **Não chama o BullMQ se a conexão não está `ready`**: falha na hora com `QueueUnavailableError`.
3. Reconecta em segundo plano (no máximo a cada 2 s) e loga só as mudanças de estado, não cada tentativa.

**`isAvailable()`** lê o estado da conexão que o cliente já conhece, sem ida à rede. A varredura usa para nem
consultar o Mongo com o Redis fora. É otimização, não garantia: Redis **travado** continua `ready` e o enqueue falha
mesmo assim (*check-then-act*), por isso a varredura segue parando na primeira falha.

**`jobId` codificado:** o BullMQ recusa id que seja inteiro (`"12345"`) ou que tenha `:` (com uma exceção
inconsistente: aceita exatamente 3 partes, por compatibilidade com um formato antigo). Como a chave vem do cliente,
o adapter usa `k_` + base64url da chave: nunca numérico, sem `:`, sem colisão e reversível.

## Resiliência com a Frankfurter

- **Healthcheck** (`GET /health`), **três estados**:

  | Situação | `status` | HTTP |
  |---|---|---|
  | Tudo de pé | `ok` | 200 |
  | Redis fora, circuito da Frankfurter aberto/half-open, ou moedas vindas do fallback | `degraded` | 200 |
  | Mongo fora (ping com timeout de 1 s) | `down` | 503 |

  Só o Mongo derruba: sem ele não há onde gravar pedidos. Com Redis ou Frankfurter fora a app **continua aceitando
  pedidos** (o enriquecimento só espera), então a instância deve continuar recebendo tráfego do load balancer.
  Só o Mongo é pingado; Redis e Frankfurter reportam o estado que os clientes já conhecem (conexão, circuito,
  origem da lista de moedas), então consultar o `/health` nunca gera carga na API externa.
  Moedas vindas do fallback trazem um `hint`: é o sintoma de `FRANKFURTER_BASE_URL` errada.
  O `@nestjs/terminus` saiu: ele só tem up/down (qualquer indicador fora vira 503), sem o "degradado".
  O serviço `app` do docker-compose usa o `/health` como healthcheck (via `fetch` do Node; a imagem alpine não tem
  `curl`). No boot, a app sobe mesmo com a Frankfurter fora, para não perder pedidos.
- **Circuit breaker** próprio e genérico (`shared/resilience`), relógio injetado para teste:
  `CIRCUIT_FAILURE_THRESHOLD` falhas **consecutivas** abrem; após `CIRCUIT_RESET_TIMEOUT_MS` vira half-open e
  deixa passar **um** teste por vez; teste ok fecha, teste com falha reabre na hora (por mais um período inteiro).
- **Só queda conta como falha.** `isFailure` recebe só `ProviderUnavailableError`: um 4xx prova que a Frankfurter
  está respondendo, então nem conta nem zera a contagem; no half-open, um 4xx fecha o circuito.
- **Decorator** (`CircuitBreakingExchangeRateProvider`) envolve qualquer provedor; o cliente HTTP não sabe do breaker.
  Com o circuito aberto, a chamada falha como `ProviderUnavailableError` (temporária): um worker que corre contra a
  abertura do circuito tenta de novo em vez de falhar o pedido. O `EnrichOrder` checa `isAvailable()` antes, então
  a maioria dos jobs nem chega a chamar.
- **Estado por processo:** cada instância tem seu circuito. Com várias instâncias, cada uma aprende sozinha que a
  Frankfurter caiu (algumas chamadas a mais). Circuito compartilhado (no Redis) fica como melhoria.
- **Circuito aberto:** o worker devolve o job para a fila com `worker.rateLimit()` + `RateLimitError`,
  **sem gastar tentativa**; o pedido continua `RECEIVED` e a fila volta a andar quando o circuito fecha.

### Cliente HTTP (`FrankfurterClient`)

`fetch` nativo com `AbortSignal.timeout(FRANKFURTER_TIMEOUT_MS)`. Mapeamento conferido na API real:

| Resposta | Erro | Por quê |
|---|---|---|
| 404 (moeda inexistente **ou** não suportada, ex.: `ARS`), 422 (mesma moeda), 400 | `ProviderRejectedError` | A mesma requisição nunca vai funcionar |
| 408, **429** (rate limit), 5xx | `ProviderUnavailableError` | 4xx de *momento*, não de conteúdo: tentar depois funciona |
| Timeout, rede, corpo que não é JSON, 200 sem a taxa | `ProviderUnavailableError` | Provedor instável |

**Risco aceito:** `FRANKFURTER_BASE_URL` errada também responde 404 e pareceria "moeda rejeitada" (falha
permanente em todo pedido). Mitigação: o boot consulta `/currencies` e o `/health` expõe o erro de configuração.

Nos testes, o timeout usa um **servidor HTTP local que nunca responde**, não o `delay()` do nock: abortar um `fetch`
nativo durante o atraso do nock dispara um `assert` interno do undici (erro solto que o Vitest acusa).

## Reprocessamento

- `POST /orders/reprocess`: reenfileira `FAILED_ENRICHMENT` com `retryable: true`.
- Fila separada `orders-enrichment-reprocess`, concorrência baixa e `limiter`
  (`REPROCESS_RATE_PER_SECOND`), para não competir com pedidos novos nem disparar rajada na Frankfurter.
- Novo `jobId` (chave atual + sufixo de reprocesso, codificado como os demais), limite `REPROCESS_MAX_COUNT`.
- Automático (job recorrente, só com circuito fechado): candidato a ficar documentado se o tempo apertar.

## Varredura de órfãos

- Caso de uso `EnqueueStaleOrders`: busca pedidos `RECEIVED` com `queue_checked_at` mais antigo que
  `STALE_ORDER_AFTER_MS`, em lotes de `SWEEP_BATCH_SIZE` (todos os lotes na mesma execução), e enfileira cada um
  com `jobId` = chave atual. Pedido que já tinha job: o dedup ignora; job rodando duas vezes: o worker só processa
  se `needsEnrichment`.
- **`queue_checked_at`** (metadado de persistência, fora do domínio): gravado no insert e no update, renovado pela
  varredura depois de enfileirar. A idade é medida por ele, e não pela criação, porque um pedido com job esperando
  numa fila longa continua `RECEIVED`: sem o carimbo, a varredura pegaria sempre os mesmos pedidos mais antigos
  e nunca chegaria nos outros. Se o pedido continuar `RECEIVED` por mais um período inteiro, é pego de novo.
- **Para na primeira falha de enqueue:** Redis provavelmente fora; insistir só gera erro em cascata. Os carimbados
  até ali ficam, o resto vai na próxima execução.
- **Proteção contra loop:** se um lote vier só com pedidos já vistos na execução, para (defesa contra carimbo
  que não foi renovado). No teste, o fake conta consultas e falha, porque um loop sobre promises que resolvem na
  hora roda só em microtasks e trava o próprio timeout do Vitest.
- **Agendada por um timer no processo** (`PeriodicTask`, `SWEEP_INTERVAL_MS`), não por job recorrente do BullMQ:
  a varredura existe justamente para quando o Redis falhou, então não pode depender dele para disparar. Sem
  `@nestjs/schedule`: um `setInterval` com duas regras testadas basta — **sem sobreposição** (tick que encontra a
  rodada anterior em andamento é pulado) e **erro não para o agendamento**. No shutdown, espera a rodada em andamento.
- Roda nos processos com papel de processamento (`WORKER_ENABLED=true`). Várias instâncias varrendo ao mesmo tempo é
  seguro pelo dedup, só desperdiça consultas. Em produção: lock distribuído ou uma instância dedicada.
- Log só quando agiu (pedidos reenfileirados) ou não conseguiu (fila fora, enqueue falhou); silêncio quando não havia nada.
- Índice próprio `{ status, queue_checked_at }` (a definir junto com os demais no adapter Mongo).

## API HTTP

**Respostas de sucesso:** resumo do pedido em snake_case (`id`, `order_id`, `status`, `currency`, `total`,
`revision`, `enrichment`, `failure`). **Nunca** devolve dados do cliente (e-mail, nome) nem o array de chaves.
`POST /webhooks/orders`: **202** criado ou atualizado (o enriquecimento é assíncrono), **200** duplicado.

**Erros, todos no mesmo formato** `{ statusCode, code, message, request_id, errors? }`. O `code` é estável: o
cliente trata por ele, não pela mensagem. Tabela única em `shared/http/http-error.ts`:

| Situação | Status | `code` |
|---|---|---|
| Payload fora do contrato (lista **todos** os campos, um erro por campo) | 400 | `INVALID_PAYLOAD` |
| Corpo que não é JSON | 400 | `MALFORMED_JSON` |
| Corpo acima de `BODY_LIMIT` | 413 | `PAYLOAD_TOO_LARGE` |
| Mesmo `order_id`, outra chave (`reject`) | 409 | `ORDER_ALREADY_EXISTS` |
| Update com pedido em `ENRICHING` / acima do teto / concorrente | 409 | `ORDER_BEING_PROCESSED` / `REVISION_LIMIT_REACHED` / `CONCURRENT_UPDATE` |
| Mesma chave para outro `order_id` | 422 | `IDEMPOTENCY_KEY_REUSED` |
| Qualquer erro nosso inesperado | 500 | `INTERNAL_ERROR` (detalhe só no log) |

- **Campos desconhecidos são ignorados**, não recusados: provedores adicionam campos com o tempo.
- **Limites no DTO** (tamanho de textos, até 500 itens, chave até 255) para uma requisição não ser abusiva.
- **`request_id`:** o `x-request-id` do cliente (até 128 caracteres) ou um gerado; volta no header da resposta, em
  todo log e em todo corpo de erro. Erros do body-parser acontecem antes do logger, por isso o filtro também atribui.
- **Erros do body-parser no Nest 12:** JSON inválido chega como `BadRequestException` com o erro original em `cause`;
  corpo grande chega como `HttpException(413)`. O mapeamento olha o erro e o `cause`.
- **`configureApp()`** concentra body limit, validação e filtro de erro; `main.ts` e os testes e2e usam a mesma
  função, então os testes exercitam a configuração de produção.

## Composição no Nest (`OrdersModule`)

- Os **ports (classes abstratas) são os tokens de injeção**; os adapters são criados por factories a partir da
  config validada. Os casos de uso não têm decorators do Nest.
- O repositório só fica pronto depois de `model.init()` (índices únicos), e o Nest espera factories assíncronas
  antes de abrir a porta.
- `SupportedCurrencies` aquece no boot (`warmUp`); com a Frankfurter fora, a app sobe com o fallback e loga warning.
  Se ela cair depois de já ter respondido, **a última lista boa vale mais que o fallback**; após uma falha, espera
  60 s antes de perguntar de novo (não chama a cada requisição).
- A fila usa a conexão própria do adapter (falha rápida); o `BullModule` do `@nestjs/bullmq` saiu do `AppModule`.
  O módulo fecha a fila no shutdown, porque objetos criados por factory não recebem lifecycle hooks próprios.

## Consulta

- `GET /orders?status=&order_id=`, `GET /orders/:id` (id interno), `GET /queue/metrics` (principal, reprocesso e DLQ).
- `GET /webhooks/rejections?request_id=|source=&from=&to=`.

## Fora do escopo (citar no README)

- **Autenticação do webhook com assinatura HMAC.** Hoje quem conhece a URL cria e altera pedidos.
  Em produção: segredo compartilhado (`WEBHOOK_SECRET`), headers `X-Signature: sha256=HMAC(timestamp + body bruto)`
  e `X-Timestamp`; comparação em tempo constante (`timingSafeEqual`), janela de 5 min contra replay, 401 antes de
  validar ou tocar no banco (protege também a coleção de auditoria contra flood). Ficou de fora para manter o teste
  do avaliador simples (um `curl` sem assinar).
- **Rate limit** (`@nestjs/throttler`) por origem e por `order_id`.
- Alternativa de idempotência com coleção `idempotency_records` + TTL (modelo Stripe): chaves expiram e dá para
  devolver a resposta original exata; custo é manter duas coleções consistentes sem transação.
- Outbox transacional para consistência banco ↔ fila (exige Mongo em replica set). A varredura de órfãos cobre
  o mesmo buraco com atraso de alguns minutos; o outbox fecharia em segundos.
- Change Streams para exportar rejeições em tempo real.
- Logs de rejeição em ferramenta de observabilidade em vez do Mongo.
