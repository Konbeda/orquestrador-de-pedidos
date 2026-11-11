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
| Mesma `idempotency_key` | 200 + pedido existente, sem reenfileirar |
| Mesmo `order_id`, outra chave, `ORDER_DUPLICATE_POLICY=reject` (padrão) | 409 |
| Mesmo `order_id`, outra chave, `ORDER_DUPLICATE_POLICY=update` | Ver tabela abaixo |

Política `update` por status atual:

| Status | Ação |
|---|---|
| `RECEIVED` | Atualiza; o job na fila lê a versão nova |
| `ENRICHING` | 409 (worker está processando; evita corrida) |
| `ENRICHED` / `FAILED_ENRICHMENT` | Atualiza, volta para `RECEIVED`, reenfileira com `jobId` = nova chave |

Guarda `revision` e as `idempotency_keys` aplicadas. **Risco aceito:** sem versão no payload,
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

- **Healthcheck** (`GET /health`, terminus): Mongo e Redis são críticos; Frankfurter é *degradável*
  (reporta `degraded`, não derruba). No start só loga warning: a app sobe mesmo com ela fora, para não perder pedidos.
- **Circuit breaker** próprio (closed → open → half-open), com relógio injetado para teste.
- **Circuito aberto:** o worker devolve o job para a fila com `worker.rateLimit()` + `RateLimitError`,
  **sem gastar tentativa**; o pedido continua `RECEIVED` e a fila volta a andar quando o circuito fecha.

## Reprocessamento

- `POST /orders/reprocess`: reenfileira `FAILED_ENRICHMENT` com `retryable: true`.
- Fila separada `orders-enrichment-reprocess`, concorrência baixa e `limiter`
  (`REPROCESS_RATE_PER_SECOND`), para não competir com pedidos novos nem disparar rajada na Frankfurter.
- Novo `jobId` (`{key}:reprocess:{n}`), limite `REPROCESS_MAX_COUNT`.
- Automático (job recorrente, só com circuito fechado): candidato a ficar documentado se o tempo apertar.

## Consulta

- `GET /orders?status=&order_id=`, `GET /orders/:id` (id interno), `GET /queue/metrics` (principal, reprocesso e DLQ).
- `GET /webhooks/rejections?request_id=|source=&from=&to=`.

## Fora do escopo (citar no README)

- Outbox transacional para consistência banco ↔ fila (exige Mongo em replica set).
- Change Streams para exportar rejeições em tempo real.
- Logs de rejeição em ferramenta de observabilidade em vez do Mongo.
