# Fluxos das regras de negócio

Caminho feliz e caminhos tristes, em partes pequenas. O porquê de cada regra está em [DECISIONS.md](DECISIONS.md).

**Legenda:** 🟩 caminho feliz · 🟥 recusa ou falha · 🟨 recuperação automática (algo deu errado e o sistema se corrige)

- [1. Webhook: contrato](#1-webhook-contrato)
- [2. Webhook: idempotência e conflitos](#2-webhook-idempotência-e-conflitos)
- [3. Webhook: pedido novo](#3-webhook-pedido-novo)
- [4. Worker de enriquecimento](#4-worker-de-enriquecimento)
- [5. Varredura de órfãos](#5-varredura-de-órfãos)
- [6. Reprocessamento](#6-reprocessamento)
- [7. Circuit breaker da Frankfurter](#7-circuit-breaker-da-frankfurter)

## 1. Webhook: contrato

Toda violação de contrato é recusada **e auditada** em `webhook_rejections` (dados pessoais mascarados).

```mermaid
flowchart TD
    IN(["POST /webhooks/orders"]) --> SIZE{"Corpo acima<br/>do BODY_LIMIT?"}
    SIZE -- sim --> E413["413 PAYLOAD_TOO_LARGE<br/>auditado só com o tamanho"]
    SIZE -- não --> JSON{"JSON válido?"}
    JSON -- não --> E400J["400 MALFORMED_JSON<br/>auditado só com o hash"]
    JSON -- sim --> DTO{"Contrato válido?<br/>campos, tipos,<br/>ISO 4217, limites"}
    DTO -- não --> E400["400 INVALID_PAYLOAD<br/>lista todos os campos<br/>auditado e mascarado"]
    DTO -- sim --> NEXT(["segue para a<br/>idempotência (2)"])

    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef sad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class NEXT ok
    class E413,E400J,E400 sad
```

## 2. Webhook: idempotência e conflitos

```mermaid
flowchart TD
    IN(["payload válido"]) --> KEY{"idempotency_key<br/>já existe?"}
    KEY -- sim --> SAMEID{"Mesmo<br/>order_id?"}
    SAMEID -- não --> E422["422<br/>IDEMPOTENCY_KEY_REUSED"]
    SAMEID -- sim --> DUP["200 duplicado<br/>mesmo pedido"]
    KEY -- não --> OID{"order_id<br/>já existe?"}
    OID -- não --> NEW(["pedido novo (3)"])
    OID -- sim --> RACE{"Já tem a<br/>nossa chave?"}
    RACE -- "sim: a gêmea gravou<br/>entre as duas buscas" --> DUP
    RACE -- não --> POLICY{"ORDER_DUPLICATE<br/>_POLICY"}
    POLICY -- reject --> E409A["409<br/>ORDER_ALREADY_EXISTS"]
    POLICY -- update --> BUSY{"Em<br/>ENRICHING?"}
    BUSY -- sim --> E409B["409<br/>ORDER_BEING_PROCESSED"]
    BUSY -- não --> REV{"Revisões<br/>no limite?"}
    REV -- sim --> E409C["409<br/>REVISION_LIMIT_REACHED"]
    REV -- não --> LOCK{"Outro salvou<br/>antes?"}
    LOCK -- sim --> E409D["409<br/>CONCURRENT_UPDATE"]
    LOCK -- não --> UPD["202 atualizado<br/>revision + 1"]

    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef sad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class DUP,UPD,NEW ok
    class E422,E409A,E409B,E409C,E409D sad
```

Duas recuperações por trás desses caminhos: no **200 duplicado**, se o pedido ainda está `RECEIVED`, ele é
reenfileirado (o enqueue original pode ter falhado; o dedup por `jobId` torna isso seguro). No **202 atualizado**,
um pedido que já tinha terminado volta para `RECEIVED` e ganha um job novo.

## 3. Webhook: pedido novo

O pedido é gravado **antes** de enfileirar: se a fila falhar, sobra um pedido sem job (recuperável), nunca um job
sem pedido.

```mermaid
flowchart TD
    IN(["pedido novo"]) --> CUR{"Moeda que a<br/>Frankfurter converte?"}
    CUR -- não --> UNSUP["202 FAILED_ENRICHMENT<br/>UNSUPPORTED_CURRENCY<br/>sem job na fila"]
    CUR -- sim --> SAVE["grava RECEIVED"]
    SAVE --> UNIQUE{"Índice único<br/>recusou?"}
    UNIQUE -- "sim: corrida com<br/>requisição gêmea" --> REEVAL["reavalia uma vez<br/>vira 200 ou 409 (2)"]
    UNIQUE -- não --> ENQ{"Enfileirou?<br/>retry 100/200/400 ms"}
    ENQ -- sim --> OK["202 RECEIVED<br/>job na fila"]
    ENQ -- "não: Redis fora" --> PENDING["202 RECEIVED<br/>a varredura (5)<br/>enfileira depois"]

    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef sad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef rec fill:#fef3c7,stroke:#d97706,color:#78350f
    class OK ok
    class UNSUP sad
    class REEVAL,PENDING rec
```

## 4. Worker de enriquecimento

Cada job tem até `ENRICHMENT_MAX_ATTEMPTS` tentativas com backoff exponencial.

```mermaid
flowchart TD
    JOB(["job da fila"]) --> FINAL{"Pedido existe e<br/>ainda não terminou?"}
    FINAL -- não --> SKIP["concluído sem efeito<br/>job repetido ou fantasma"]
    FINAL -- sim --> BRL{"Moeda já é a<br/>de destino?"}
    BRL -- sim --> DONE
    BRL -- não --> CIRCUIT{"Circuito<br/>aberto?"}
    CIRCUIT -- sim --> PAUSE["pausa a fila<br/>sem gastar tentativa<br/>continua RECEIVED"]
    CIRCUIT -- não --> CALL["grava ENRICHING<br/>chama a Frankfurter"]
    CALL --> RESP{"Resposta"}
    RESP -- 200 --> DONE["ENRICHED<br/>total convertido"]
    RESP -- "404 · 422 · 400" --> REJ["FAILED_ENRICHMENT<br/>PROVIDER_REJECTED<br/>não reprocessável + DLQ"]
    RESP -- "5xx · 429 · timeout<br/>ou erro nosso" --> LAST{"Última<br/>tentativa?"}
    LAST -- não --> RETRY["tenta de novo<br/>com backoff"]
    LAST -- sim --> FAILED["FAILED_ENRICHMENT<br/>reprocessável + DLQ"]

    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef sad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef rec fill:#fef3c7,stroke:#d97706,color:#78350f
    class DONE ok
    class REJ,FAILED sad
    class SKIP,PAUSE,RETRY rec
```

Dois detalhes que não cabem no desenho: se o cliente atualizar o pedido enquanto o worker trabalha, o lock otimista
manda o job tentar de novo com os dados novos; e se as tentativas acabarem com o pedido ainda `RECEIVED`, o worker
apaga o job falho para liberar o `jobId` e a varredura reenfileira.

## 5. Varredura de órfãos

Roda a cada `SWEEP_INTERVAL_MS` e pega pedidos `RECEIVED` sem job (o enqueue falhou e o cliente não repetiu).

```mermaid
flowchart TD
    TICK(["a cada intervalo"]) --> RUN{"Rodada anterior<br/>em andamento?"}
    RUN -- sim --> SKIP1["pula este tick"]
    RUN -- não --> REDIS{"Redis sabidamente<br/>fora?"}
    REDIS -- sim --> SKIP2["pula sem<br/>consultar o Mongo"]
    REDIS -- não --> FIND["busca RECEIVED parados há<br/>mais de STALE_ORDER_AFTER_MS"]
    FIND --> ENQ{"Enfileirou?"}
    ENQ -- sim --> STAMP["renova a checagem<br/>e segue o lote"]
    ENQ -- não --> STOP["para: o resto fica<br/>para o próximo tick"]

    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef rec fill:#fef3c7,stroke:#d97706,color:#78350f
    class STAMP ok
    class SKIP1,SKIP2,STOP rec
```

## 6. Reprocessamento

`POST /orders/reprocess`, por ids ou em lote. Cada pedido recusado volta com o motivo.

```mermaid
flowchart TD
    REQ(["cada pedido"]) --> CHECK{"Existe, está FAILED,<br/>é retryable e está<br/>abaixo do limite?"}
    CHECK -- não --> SKIPPED["skipped: NOT_FOUND ·<br/>NOT_FAILED · NOT_RETRYABLE ·<br/>LIMIT_REACHED"]
    CHECK -- sim --> SAVE["grava RECEIVED<br/>reprocess_count + 1"]
    SAVE --> LOCK{"Alguém salvou<br/>antes?"}
    LOCK -- sim --> CONC["skipped:<br/>CONCURRENT_UPDATE"]
    LOCK -- não --> ENQ["enfileira com prioridade baixa<br/>jobId novo: chave#reprocess-N"]
    ENQ --> WORKER(["worker (4)<br/>pedidos novos passam na frente"])

    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef sad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class ENQ,WORKER ok
    class SKIPPED,CONC sad
```

## 7. Circuit breaker da Frankfurter

```mermaid
flowchart LR
    CLOSED(["closed<br/>chamadas normais"]) -- "N quedas seguidas<br/>(4xx não contam)" --> OPEN(["open<br/>nenhuma chamada<br/>fila pausada"])
    OPEN -- "passou o<br/>RESET_TIMEOUT" --> HALF(["half-open<br/>uma chamada<br/>de teste"])
    HALF -- "teste ok" --> CLOSED
    HALF -- "teste falhou" --> OPEN

    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef sad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef rec fill:#fef3c7,stroke:#d97706,color:#78350f
    class CLOSED ok
    class OPEN sad
    class HALF rec
```
