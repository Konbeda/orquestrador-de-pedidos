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
   cobre piscadas do Redis sem o cliente perceber.
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
| `orders` | `idempotency_key` unique | Idempotência por requisição |
| `orders` | `order_id` unique | Mesmo pedido com outra chave |
| `orders` | `{ status, retryable, createdAt }` | `GET /orders?status=` e varredura de reprocessamento |
| `webhook_rejections` | `request_id` unique | Consulta pontual do suporte |
| `webhook_rejections` | `{ source, received_at }` | "Rejeições do cliente X no período" |
| `webhook_rejections` | `received_at` TTL | Exportação por período + expurgo automático |

Sem índice em `errors`/`error_codes` por enquanto: coleção é muito mais escrita que lida.
`error_codes` já é gravado; o índice pode ser criado depois sem mudar código.

## Enriquecimento, retry e DLQ

- Erro **temporário** (timeout, 5xx): relança; BullMQ tenta de novo com backoff exponencial
  (`ENRICHMENT_MAX_ATTEMPTS`, `ENRICHMENT_BACKOFF_MS`).
- Erro **permanente** (4xx, moeda rejeitada): `UnrecoverableError`, direto para a DLQ.
- Tentativas esgotadas: job copiado para `orders-enrichment-dlq`, status `FAILED_ENRICHMENT`.

## Resiliência com a Frankfurter

- **Healthcheck** (`GET /health`, terminus): Mongo é crítico; Redis e Frankfurter são *degradáveis*
  (reportam `degraded`, não derrubam): sem Redis o recebimento continua e a varredura enfileira depois. No start só loga warning: a app sobe mesmo com ela fora, para não perder pedidos.
- **Circuit breaker** próprio (closed → open → half-open), com relógio injetado para teste.
- **Circuito aberto:** o worker devolve o job para a fila com `worker.rateLimit()` + `RateLimitError`,
  **sem gastar tentativa**; o pedido continua `RECEIVED` e a fila volta a andar quando o circuito fecha.

## Reprocessamento

- `POST /orders/reprocess`: reenfileira `FAILED_ENRICHMENT` com `retryable: true`.
- Fila separada `orders-enrichment-reprocess`, concorrência baixa e `limiter`
  (`REPROCESS_RATE_PER_SECOND`), para não competir com pedidos novos nem disparar rajada na Frankfurter.
- Novo `jobId` (`{key}:reprocess:{n}`), limite `REPROCESS_MAX_COUNT`.
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
- Agendada pelo `@nestjs/schedule` (timer no processo), não por job recorrente do BullMQ: a varredura existe
  justamente para quando o Redis falhou, então não pode depender dele para disparar.
- Com várias instâncias da API, cada uma varre; é seguro pelo dedup, só desperdiça consultas. Em produção:
  lock distribuído ou uma instância dedicada.
- Índice próprio `{ status, queue_checked_at }` (a definir junto com os demais no adapter Mongo).

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
