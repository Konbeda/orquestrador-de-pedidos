# Backlog (TDD)

Ordem de dentro para fora: domínio → casos de uso → adapters → HTTP/worker → e2e.
Cada item começa com o teste vermelho. Decisões e motivos em [DECISIONS.md](DECISIONS.md).

## Feito

- [x] Scaffold, config validada (zod), docker-compose, Vitest unit/integration/e2e com Testcontainers
- [x] Domínio `Order`: status, dinheiro em centavos, falha com motivo, reprocesso com limite, update por status
- [x] `MAX_ORDER_REVISIONS`
- [x] `ReceiveOrder`: criado / duplicado / update, moeda não suportada, corridas, lock otimista
- [x] `ReceiveOrder`: retry interno do enqueue e 202 com `pendingEnqueue` quando o Redis está fora

## Casos de uso (unit, com fakes)

- [ ] `EnrichOrder` (worker): sucesso, pedido já final não faz nada, erro temporário relança, erro permanente
      vira `UnrecoverableError`, circuito aberto devolve o job sem gastar tentativa
- [ ] Tentativas esgotadas: `FAILED_ENRICHMENT` + job copiado para a DLQ
- [ ] Circuit breaker (closed → open → half-open), relógio injetado
- [ ] `SupportedCurrencies`: carrega da Frankfurter, fallback quando fora, TTL do cache
- [ ] **`EnqueueStaleOrders` (varredura de órfãos):** pega só `RECEIVED` mais antigos que o limite, em lotes,
      enfileira com a chave atual, ignora os recentes, segue o lote mesmo se um enqueue falhar
- [ ] `ReprocessOrders`: só `retryable`, respeita o limite, fila de reprocesso separada, `jobId` novo
- [ ] `maskPII()` e montagem do registro de rejeição (`error_codes`, `payload_hash`)

## Adapters (integration, Mongo/Redis reais)

- [ ] `MongoOrderRepository`: índices únicos (inclusive sobre o array de chaves), E11000 → `DuplicateOrderError`,
      lock otimista por `revision`, 10 inserts simultâneos = 1 pedido
- [ ] Contrato compartilhado: a mesma suíte roda contra o fake e o Mongo, provando que o fake não mente
- [ ] `BullMqEnrichmentQueue`: dedup por `jobId`, retry com backoff, DLQ
- [ ] `FrankfurterClient` (nock): sucesso, timeout, 4xx, 5xx, `/currencies`
- [ ] `webhook_rejections`: índices (request_id unique, source+received_at, TTL)

## HTTP e worker

- [ ] `POST /webhooks/orders`: DTO (class-validator, ISO 4217), 400 com `request_id` + auditoria, 413,
      mapeamento de erros (409 / 422), `x-request-id` na resposta, warning quando `pendingEnqueue`
- [ ] `GET /orders`, `GET /orders/:id` (sem expor o array de chaves), `GET /queue/metrics`
- [ ] `POST /orders/reprocess`, `GET /webhooks/rejections`
- [ ] `GET /health` (Mongo crítico; Redis e Frankfurter degradáveis)
- [ ] Agendamento da varredura (`@nestjs/schedule`)

## E2E

- [ ] POST → 202 → worker → `ENRICHED`
- [ ] Frankfurter sempre falhando → `FAILED_ENRICHMENT` + DLQ + métricas
- [ ] 10 POST simultâneos iguais → 1 pedido, 1 job
- [ ] Payload inválido → 400 + registro mascarado

## Entrega

- [ ] README (como rodar, decisões, melhorias futuras)
- [ ] Limpar `AGENTS.md` do template
- [ ] Publicar no GitHub
