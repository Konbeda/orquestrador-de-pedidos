# Backlog (TDD)

Ordem de dentro para fora: domínio → casos de uso → adapters → HTTP/worker → e2e.
Cada item começa com o teste vermelho. Decisões e motivos em [DECISIONS.md](DECISIONS.md).

## Feito

- [x] Scaffold, config validada (zod), docker-compose, Vitest unit/integration/e2e com Testcontainers
- [x] Domínio `Order`: status, dinheiro em centavos, falha com motivo, reprocesso com limite, update por status
- [x] `MAX_ORDER_REVISIONS`
- [x] `ReceiveOrder`: criado / duplicado / update, moeda não suportada, corridas, lock otimista
- [x] `ReceiveOrder`: retry interno do enqueue e 202 com `pendingEnqueue` quando o Redis está fora
- [x] `EnqueueStaleOrders` (varredura de órfãos): carimbo `queue_checked_at`, lotes, para na falha, proteção contra loop
- [x] Varredura pula a execução quando `isAvailable()` diz que a fila caiu
- [x] `BullMqEnrichmentQueue` (produtor): falha rápida medida (parado, travado, boot sem Redis), dedup, `jobId` codificado
- [x] `ReceiveOrder` desiste na hora (sem dormir) quando `isAvailable()` diz que o Redis caiu
- [x] `EnrichOrder`: sucesso, job repetido/fantasma, temporário x permanente x interno, última tentativa,
      circuito aberto, lock otimista com o cliente, falhas de banco ao salvar
- [x] Circuit breaker genérico (closed → open → half-open, um teste por vez, só queda conta)
- [x] `FrankfurterClient` (nock + servidor lento real): mapeamento conferido na API, 429 temporário, `/currencies`
- [x] `CircuitBreakingExchangeRateProvider` (decorator)

## Casos de uso (unit, com fakes)

- [ ] Varredura de `ENRICHING` parados (fecha a lacuna de quando nem a falha consegue ser gravada)
- [ ] `SupportedCurrencies`: carrega da Frankfurter, fallback quando fora, TTL do cache
- [ ] `ReprocessOrders`: só `retryable`, respeita o limite, fila de reprocesso separada, `jobId` novo
- [ ] `maskPII()` e montagem do registro de rejeição (`error_codes`, `payload_hash`)

## Adapters (integration, Mongo/Redis reais)

- [ ] `MongoOrderRepository`: índices únicos (inclusive sobre o array de chaves), E11000 → `DuplicateOrderError`,
      lock otimista por `revision`, 10 inserts simultâneos = 1 pedido,
      `queue_checked_at` + `findStaleReceived` / `markQueueChecked`
- [ ] Contrato compartilhado: a mesma suíte roda contra o fake e o Mongo, provando que o fake não mente
- [ ] Worker BullMQ: traduz os erros do `EnrichOrder` (retry com backoff, `UnrecoverableError` + DLQ,
      `rateLimit` + `RateLimitError` com circuito aberto)
- [ ] `webhook_rejections`: índices (request_id unique, source+received_at, TTL)

## HTTP e worker

- [ ] `POST /webhooks/orders`: DTO (class-validator, ISO 4217), 400 com `request_id` + auditoria, 413,
      mapeamento de erros (409 / 422), `x-request-id` na resposta, warning quando `pendingEnqueue`
- [ ] `GET /orders`, `GET /orders/:id` (sem expor o array de chaves), `GET /queue/metrics`
- [ ] `POST /orders/reprocess`, `GET /webhooks/rejections`
- [ ] `GET /health` (Mongo crítico; Redis e Frankfurter degradáveis), check de `/currencies` no boot
      (expõe `FRANKFURTER_BASE_URL` errada)
- [ ] Agendamento da varredura (`@nestjs/schedule`, `SWEEP_INTERVAL_MS`), log do resultado de cada execução

## E2E

- [ ] POST → 202 → worker → `ENRICHED`
- [ ] Frankfurter sempre falhando → `FAILED_ENRICHMENT` + DLQ + métricas
- [ ] 10 POST simultâneos iguais → 1 pedido, 1 job
- [ ] Payload inválido → 400 + registro mascarado

## Entrega

- [ ] README (como rodar, decisões, melhorias futuras)
- [ ] Limpar `AGENTS.md` do template
- [ ] Publicar no GitHub
