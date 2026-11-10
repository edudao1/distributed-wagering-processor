# Distributed Wagering Processor

Serviço de processamento de transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) com garantias financeiras fortes: sem perda, sem duplicidade, sem saldo negativo e com ledger auditável, rodando em várias instâncias ao mesmo tempo.

- **Runtime:** Bun 1.x + TypeScript strict
- **Framework:** NestJS (apenas na borda — domínio e aplicação são TypeScript puro)
- **Banco:** PostgreSQL 16 via MikroORM v6 (migrations reversíveis)
- **Mensageria:** Amazon SQS FIFO (LocalStack 3.8 ou MiniStack em desenvolvimento)
- **Observabilidade:** logs JSON (pino), métricas Prometheus (`/metrics`), health checks

Decisões de arquitetura, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Pré-requisitos

| Ferramenta | Versão | Observação |
|---|---|---|
| Bun | 1.1+ | `bun --version` |
| Docker + Docker Compose | 24+ | No Windows: Docker Desktop com backend WSL2 |

### Instalação no Windows

```bash
wsl --install
```

Reinicie o computador, instale o [Docker Desktop](https://www.docker.com/products/docker-desktop/) e ative "Use the WSL 2 based engine". Depois instale o Bun:

```bash
powershell -c "irm bun.sh/install.ps1 | iex"
```

Feche e reabra o terminal e confira:

```bash
bun --version
```

```bash
docker compose version
```

### Instalação no Linux/macOS

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## 2. Subindo tudo com Docker Compose (3 instâncias)

```bash
docker compose up --build
```

Isso sobe:

| Serviço | Porta | Função |
|---|---|---|
| `postgres` | 5432 | banco (`max_connections=300`) |
| `localstack` | 4566 | SQS |
| `migrate` | — | roda `db:migrate` e `sqs:setup` uma vez e termina |
| `app-1`, `app-2`, `app-3` | 3001, 3002, 3003 | três instâncias do serviço (HTTP + consumidor SQS + publisher do outbox + worker de referências pendentes) |

Para usar **MiniStack** no lugar do LocalStack, basta apontar `SQS_ENDPOINT` para ele — o código não depende de nada específico do LocalStack.

## 3. Rodando localmente (sem containers para a aplicação)

```bash
bun install
```

```bash
cp .env.example .env
```

```bash
bun run infra:up
```

```bash
bun run db:migrate
```

```bash
bun run sqs:setup
```

```bash
bun run dev
```

Reverter a migration:

```bash
bun run db:rollback
```

---

## 4. Testes

Os testes de integração e concorrência usam o Postgres e o SQS reais do `docker compose` (`bun run infra:up` antes). Cada arquivo de teste cria suas próprias filas com nome aleatório, então os arquivos não interferem entre si.

```bash
bun run typecheck
```

```bash
bun run test:unit
```

```bash
bun run test:integration
```

```bash
bun run test:concurrency
```

```bash
bun run test
```

| Suite | O que prova |
|---|---|
| `tests/unit` | `Money` (precisão, arredondamento proibido), invariantes da `Wallet`, ledger, máquina de estados da transação, regras do `WagerSettlement` (referências, reversões, saldo insuficiente), idempotência com Unit of Work em memória |
| `tests/integration/schema` | migration `down` → `up`, triggers (ledger append-only, cadeia de saldo, transação terminal imutável), constraints |
| `tests/integration/atomicity` | crash antes do commit não deixa rastro; violação de unique no flush desfaz tudo; sucesso grava ledger + outbox na mesma transação |
| `tests/integration/http-api` | contrato HTTP (201/200/202/400/403/404/409/422/503), consultas, paginação do ledger, reconciliação |
| `tests/integration/inbox-and-dlq` | redelivery deduplicada pelo inbox, payload adulterado → DLQ, rejeição de negócio é ack, erro transitório → backoff → DLQ |
| `tests/integration/outbox` | publicação após commit, dois publishers concorrentes sem duplicar, lease expirado de instância morta, retry com backoff, dedup FIFO |
| `tests/concurrency/same-wallet` | mesma BET 50× em paralelo → 1 débito; 2×80 em 100 → 1 PROCESSED + 1 REJECTED; 200 apostas na carteira quente; 10 REFUNDs concorrentes → 1 crédito |
| `tests/concurrency/out-of-order` | REFUND/ROLLBACK antes da referência → 202 → processado quando a referência chega; referência que nunca chega → REJECTED `REFERENCE_NOT_FOUND` |
| `tests/concurrency/crash-recovery` | worker morre depois do commit e antes do ack; `SIGKILL` no meio do stream e restart |
| `tests/concurrency/multi-instance` | 3 processos reais compartilhando banco e fila, tráfego HTTP + SQS misturado |

Todos os testes terminam com `expectConsistent(walletId)`: saldo da carteira = soma do ledger = `balance_after` da última entrada.

### Teste de carga (opcional)

Com as três instâncias de pé (`docker compose up --build`):

```bash
bun run test:load
```

Variáveis: `LOAD_BASE_URLS` (padrão `http://localhost:3001,http://localhost:3002,http://localhost:3003`), `LOAD_WALLETS`, `LOAD_REQUESTS`, `LOAD_CONCURRENCY`, `LOAD_HOT_WALLET_SHARE`, `LOAD_DUPLICATE_SHARE`. O resultado (p50/p95/p99, throughput, taxa de erro, conflitos de lock, duplicatas, lag do outbox) vai para `load-test-results.json`.

---

## 5. API

Todas as respostas de erro usam o envelope:

```json
{ "error": { "code": "IDEMPOTENCY_CONFLICT", "message": "...", "retryable": false, "details": {} } }
```

### Carteiras

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria carteira `{ "playerId": "<uuid>", "initialBalance": { "amount": "100.00", "currency": "BRL" } }` → 201 |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?limit=50&cursor=...` | ledger paginado por cursor (keyset em `seq`) |
| `POST` | `/wallets/:walletId/reconciliation` | recalcula o saldo a partir do ledger e compara |

### Transações

`POST /wagering/transactions` com header **`Idempotency-Key`** obrigatório:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-123",
  "playerId": "8b7d...",
  "walletId": "0f3c...",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

REFUND e ROLLBACK exigem `referenceExternalTransactionId`.

| Situação | Status HTTP | Corpo |
|---|---|---|
| processada agora | 201 | `{ transactionId, status: "PROCESSED", balance, idempotentReplay: false }` |
| replay da mesma chave e mesmo payload | 200 | mesma resposta, `idempotentReplay: true` |
| esperando a transação referenciada | 202 | `status: "PENDING_REFERENCE"` |
| rejeitada por regra de negócio | 422 | `status: "REJECTED"`, `failureCode` |
| mesma chave com payload diferente | 409 | `IDEMPOTENCY_CONFLICT` (`PAYLOAD_MISMATCH` ou `EXTERNAL_ID_REUSED`) |
| payload inválido / sem chave | 400 | `INVALID_PAYLOAD` / `IDEMPOTENCY_KEY_REQUIRED` |
| carteira inexistente | 404 | `WALLET_NOT_FOUND` |
| lock timeout, banco indisponível | 503 + `Retry-After` | `TEMPORARILY_UNAVAILABLE`, `retryable: true` |

| Método | Rota |
|---|---|
| `GET` | `/wagering/transactions/:transactionId` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` |

### Operação

| Rota | Descrição |
|---|---|
| `GET /health/live` | processo vivo |
| `GET /health/ready` | Postgres (`select 1`) e SQS (`GetQueueAttributes`) respondem em até 2s |
| `GET /metrics` | métricas Prometheus |

### Mensagem SQS (fila `wager-transactions.fifo`)

```json
{
  "messageId": "msg-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-09T12:00:00.000Z",
  "data": { "idempotencyKey": "provider-a:tx-123", "...mesmos campos do POST..." }
}
```

`MessageGroupId` deve ser o `walletId` (ordem por carteira). Eventos de saída vão para `wagering-events.fifo`; mensagens que não podem ser processadas vão para `wager-transactions-dlq.fifo` com o atributo `failureReason`.

---

## 6. Configuração

Todas as variáveis estão em [.env.example](.env.example) e são validadas com zod na inicialização (o processo não sobe com configuração inválida).

## 7. Estrutura

```
src/
  domain/          regras de negócio puras (Money, Wallet, Ledger, WagerTransaction, WagerSettlement, eventos)
  application/     casos de uso + portas (interfaces) — sem Nest, sem ORM
  infrastructure/  MikroORM, SQL, SQS, hashing, logs, métricas, workers
  interfaces/      HTTP (controllers, filtro de erros, auth) e consumidor SQS
  config/          configuração tipada
scripts/           migrate, setup das filas, teste de carga
tests/             unit, integration, concurrency + helpers
```
