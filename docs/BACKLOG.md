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
- [x] `MongoOrderRepository` + teste de contrato (fake e Mongo real): unique multikey, E11000, lock otimista,
      10 inserts simultâneos = 1 pedido, varredura
- [x] `SupportedCurrencies` com cache, fallback e "última lista boa vale mais que o fallback"
- [x] `OrdersModule` (ports como tokens, `model.init()` antes do tráfego) e `configureApp` compartilhado
- [x] `POST /webhooks/orders`: DTO, 202/200/409/422/400/413, formato único de erro, `x-request-id`
- [x] Worker BullMQ: processor puro + worker; rate limit sem gastar tentativa, DLQ, libera `jobId` para a varredura,
      `WORKER_ENABLED`; e2e do fluxo completo (enriquecido, mesma moeda, falha + DLQ, circuito pausando a fila)
- [x] Varredura agendada (`PeriodicTask` sem sobreposição) + e2e: órfão sem job termina enriquecido
- [x] `GET /health` com 3 estados (só Mongo derruba), hint de `FRANKFURTER_BASE_URL`, healthcheck no compose
- [x] `GET /orders` (cursor, filtros, contrato no fake e no Mongo), `GET /orders/:id`, `GET /queue/metrics`
      (contagens, pausa do circuito, DLQ; 503 rápido com Redis fora)
- [x] Auditoria em `webhook_rejections`: allowlist + máscara, nomes de campos desconhecidos, hash dos bytes brutos,
      TTL com `collMod`, `GET /webhooks/rejections`

## Casos de uso (unit, com fakes)

- [ ] Varredura de `ENRICHING` parados (fecha a lacuna de quando nem a falha consegue ser gravada)
- [ ] `ReprocessOrders`: só `retryable`, respeita o limite, fila de reprocesso separada, `jobId` novo

## Adapters (integration, Mongo/Redis reais)


## HTTP e worker

- [ ] Swagger: `@ApiProperty` nos DTOs e respostas documentadas
- [ ] `POST /orders/reprocess`

## E2E


## Entrega

- [ ] README (como rodar, decisões, melhorias futuras)
- [ ] Limpar `AGENTS.md` do template
- [ ] Publicar no GitHub
