# Arquitetura

Este documento explica **por que** o sistema é como é: as decisões, as alternativas descartadas, os trade-offs e as limitações conhecidas.

## 1. Visão geral

```
            HTTP (Idempotency-Key)                    SQS FIFO (MessageGroupId = walletId)
                    │                                                │
        ┌───────────▼────────────┐                    ┌──────────────▼──────────────┐
        │  WageringController    │                    │  WagerTransactionConsumer   │
        │  (zod → command)       │                    │  inbox + classificação erro │
        └───────────┬────────────┘                    └──────────────┬──────────────┘
                    └──────────────┬──────────────────────────────────┘
                                   ▼
                    ProcessWagerTransaction (caso de uso)
                                   │  UnitOfWork.run (1 transação Postgres)
           ┌───────────────────────┼─────────────────────────────────────┐
           │ 0. (SQS) INSERT no inbox ON CONFLICT DO NOTHING              │
           │ 1. busca por idempotency_key (replay rápido, sem lock)       │
           │ 2. SELECT ... FOR UPDATE na wallet                           │
           │ 3. busca de novo pela chave (quem esperou o lock vê o replay)│
           │ 4. resolve referência (REFUND/ROLLBACK/WIN/LOSS)             │
           │ 5. WagerSettlement decide (domínio puro)                     │
           │ 6. grava wallet + ledger + transaction + inbox + outbox      │
           └───────────────────────┬─────────────────────────────────────┘
                                   ▼ COMMIT
               OutboxPublisherWorker (lease + SKIP LOCKED) ──► wagering-events.fifo
               PendingReferenceWorker (retry com backoff)
```

Camadas (ports & adapters / arquitetura hexagonal):

| Camada | Depende de | Não pode depender de |
|---|---|---|
| `domain` | nada (só `decimal.js`) | Nest, MikroORM, SQS |
| `application` | `domain` + portas (interfaces) | Nest, MikroORM, SQS |
| `infrastructure` | tudo acima + bibliotecas | `interfaces` |
| `interfaces` | `application` | detalhes de persistência |

Os casos de uso não têm decorators do Nest: são instanciados por `useFactory` em `AppModule.register(config)`. Por isso os testes unitários de idempotência rodam os **mesmos** casos de uso com um `InMemoryUnitOfWork`, sem subir Nest nem banco.

## 2. Dinheiro

- **Nunca `number`.** `Money` encapsula um `Decimal` de um clone isolado do `decimal.js` (precisão 50, `ROUND_HALF_EVEN`), para que nenhuma outra biblioteca altere a configuração global.
- Entrada só por string com regex `^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$`: no máximo 2 casas. **"10.005" é rejeitado, não arredondado** — arredondar dinheiro em silêncio é bug financeiro.
- Limite superior 1e18 (cabe em `numeric(20,2)`).
- `Money.from` rejeita negativos (valor de transação). `Money.rehydrate` aceita (diferenças de reconciliação).
- Instâncias congeladas (`Object.freeze`), operações retornam nova instância, soma de moedas diferentes lança `CurrencyMismatchError`.
- **No banco:** `numeric(20,2)` + `currency char(3)`. O driver `pg` devolve `numeric` como string, então não existe passagem por `float` em nenhum ponto. No JSON a API usa `{ "amount": "25.00", "currency": "BRL" }`.

## 3. ORM e persistência

**MikroORM v6** (recomendado no desafio) com `EntitySchema`, **sem decorators nas entidades de domínio**. Os registros de persistência (`records.ts`) são separados do domínio e convertidos por `mappers.ts`. Motivo: o domínio usa construtor privado + `rehydrate`, invariantes no construtor e objetos de valor (`Money`) — misturar isso com proxies/identity map do ORM gera acoplamento e bugs sutis.

O ORM é usado para: conexão, `em.transactional`, lock pessimista (`LockMode.PESSIMISTIC_WRITE` com `refresh: true`), unit of work e migrations. Consultas que o ORM expressaria mal (paginação keyset do ledger, soma para reconciliação, `INSERT ... ON CONFLICT DO NOTHING` do inbox, claim do outbox com `FOR UPDATE SKIP LOCKED`) são SQL explícito via `em.execute` com parâmetros `?`.

**FKs `DEFERRABLE INITIALLY DEFERRED`**: a ordem de flush do MikroORM deixa de importar; integridade é verificada no commit.

## 4. Transações e concorrência

### Estratégia: lock pessimista por carteira

Cada transação financeira faz, dentro de `em.transactional` com **READ COMMITTED**:

```sql
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '15000ms';
SELECT ... FROM wallets WHERE id = $1 FOR UPDATE;
```

**Por que pessimista e não otimista (`version`)?** Carteira quente (um jogador em várias mesas) é exatamente o caso do desafio. Com lock otimista, sob contenção, a maioria das tentativas falha e precisa refazer leitura + decisão + escrita, gerando tempestade de retries e latência de cauda alta. Com `FOR UPDATE` as requisições fazem fila no Postgres, cada uma decide sobre o saldo já atualizado e o throughput por carteira fica previsível. Carteiras diferentes não disputam nada: o lock é por linha.

**Por que READ COMMITTED e não SERIALIZABLE?** Toda decisão que depende de saldo é tomada depois do `FOR UPDATE`, que serializa as escritas na mesma carteira. SERIALIZABLE adicionaria aborts por falso conflito (predicate locks) sem ganho de correção. A reconciliação usa REPEATABLE READ para ter um snapshot consistente entre "saldo da carteira" e "soma do ledger".

**Deadlocks:** cada operação trava exatamente uma carteira, então não existe ciclo de espera. O `lock_timeout` limita a espera; ao estourar vira `TransientInfrastructureError` → HTTP 503 com `Retry-After` / SQS retry com backoff.

**Corridas que o lock não cobre** (duas requisições inserindo a mesma chave ao mesmo tempo) caem nos índices únicos. A violação de unique (`23505`) é traduzida para `ConcurrentWriteConflictError` e o caso de uso **repete a operação inteira até 3 vezes**. Na repetição, a busca por idempotência encontra a transação vencedora e devolve replay.

### Invariantes garantidos pelo banco (defesa em profundidade)

O código já garante as regras, mas o banco é a última linha. Se um bug passar, o commit falha.

| Invariante | Mecanismo |
|---|---|
| saldo nunca negativo | `CHECK (balance_amount >= 0)` |
| ledger append-only | trigger: `UPDATE`/`DELETE`/`TRUNCATE` → erro `55000` |
| cadeia do ledger | trigger: `balance_before` = `balance_after` da entrada anterior; `balance_after = balance_before ± amount` (CHECK) |
| saldo da carteira = último `balance_after` | constraint trigger **deferred** (verificado no commit) |
| `version` sobe exatamente 1 quando o saldo muda | trigger em `wallets` |
| colunas imutáveis (player, moeda, ids) | triggers |
| transação terminal é imutável | trigger em `wager_transactions` |
| PROCESSED (exceto LOSS) tem exatamente 1 entrada de ledger, o resto 0 | constraint trigger deferred |
| uma referência só é revertida uma vez | índice único parcial em `reference_transaction_id WHERE kind IN ('REFUND','ROLLBACK') AND status='PROCESSED'` |
| `status` ↔ `failure_code` ↔ `processed_at` coerentes | CHECKs |
| idempotência | `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)` |

## 5. Idempotência

Duas chaves únicas, persistidas na própria `wager_transactions` (não em cache — sobrevive a restart e funciona entre instâncias):

1. `idempotency_key` (header HTTP ou `data.idempotencyKey` na mensagem SQS).
2. `(provider_id, external_transaction_id)` — o provedor não pode reutilizar o id externo com outra chave.

**Hash do payload:** SHA-256 de um **JSON canônico** (chaves ordenadas recursivamente, `undefined` descartado, `toJSON` respeitado) só dos **campos de negócio** (`businessPayload`). Assim, ordem das chaves no JSON, campos de transporte ou `messageId` não mudam o hash; valor `"25.0"` vs `"25.00"` é normalizado porque o hash é calculado sobre o `Money` já validado.

| Situação | Resultado |
|---|---|
| mesma chave + mesmo hash | replay: devolve o resultado original (inclusive REJECTED), HTTP 200, `idempotentReplay: true` |
| mesma chave + hash diferente | 409 `IDEMPOTENCY_CONFLICT` reason `PAYLOAD_MISMATCH` |
| mesmo `(provider, externalId)` com outra chave | 409 reason `EXTERNAL_ID_REUSED` |

Rejeições de negócio **são persistidas** (status REJECTED + `failure_code` + saldo observado). Um retry de uma BET rejeitada por saldo insuficiente continua rejeitado, mesmo que o saldo tenha subido depois. Isso é o comportamento correto: o provedor recebe sempre a mesma resposta para a mesma operação.

## 6. Taxonomia de falhas

| Código | Quando | Status final |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | REJECTED |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de um WIN cujo valor já foi gasto | REJECTED |
| `CURRENCY_MISMATCH` | moeda diferente da carteira | REJECTED |
| `PLAYER_WALLET_MISMATCH` | `playerId` não é dono da carteira | REJECTED |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do orçamento de retries | REJECTED |
| `REFERENCE_NOT_PROCESSED` | referência existe mas terminou REJECTED/FAILED (ou ficou pendente além do orçamento) | REJECTED |
| `REFERENCE_MISMATCH` | referência de outro provedor/jogador/carteira/rodada/moeda | REJECTED |
| `INVALID_REFERENCE_KIND` | ex.: REFUND de um WIN | REJECTED |
| `REVERSAL_AMOUNT_MISMATCH` | valor do REFUND/ROLLBACK ≠ valor original | REJECTED |
| `ALREADY_REVERSED` | a referência já foi revertida (por REFUND **ou** ROLLBACK) | REJECTED |
| `PROCESSING_FAILED` | erro não transitório inesperado ao reprocessar uma pendente | FAILED |

Para `PLAYER_WALLET_MISMATCH` e `CURRENCY_MISMATCH` **o saldo não é devolvido** na resposta (não vazar saldo de carteira de outro jogador).

**Referências permitidas:** WIN→BET, LOSS→BET, REFUND→BET, ROLLBACK→BET/WIN/REFUND. WIN e LOSS podem vir sem referência.

**Interpretação adotada (mais estrita):** uma transação só pode ser revertida **uma vez no total**, somando REFUND e ROLLBACK. Uma BET que já recebeu REFUND não pode receber ROLLBACK. Isso evita crédito duplo.

**Semântica de cada tipo:** BET = débito; WIN = crédito; LOSS = PROCESSED **sem** entrada de ledger (só registra o fim da rodada); REFUND de BET = crédito; ROLLBACK = movimento inverso da referência (ROLLBACK de BET credita, de WIN debita, de REFUND debita).

## 7. Máquina de estados

```
PENDING ──► PROCESSED
   │   ├──► REJECTED
   │   ├──► FAILED
   │   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
```

Estados terminais (PROCESSED, REJECTED, FAILED) não têm transição — garantido no domínio (`InvalidTransactionStateError`) e no banco (trigger).

## 8. Referências fora de ordem (PENDING_REFERENCE)

SQS FIFO ordena por `MessageGroupId`, mas o provedor pode mandar o REFUND por HTTP antes da BET chegar pela fila. Em vez de rejeitar na hora:

1. A transação é gravada como `PENDING_REFERENCE` com `next_reference_attempt_at` (HTTP **202**) e é emitido `WagerTransactionPendingReference` (só na primeira vez).
2. `PendingReferenceWorker` (todas as instâncias) busca as vencidas pelo índice parcial e reprocessa cada uma **sob o lock da carteira**, então várias instâncias não processam a mesma pendente duas vezes (quem chega depois vê a transação já terminal).
3. Backoff exponencial: `1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s` → com 10 tentativas, **~4 minutos** de janela.
4. Esgotado: REJECTED `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.

**Justificativa do TTL (~4 min):** cobre reordenação real entre canais (HTTP vs fila, redelivery após visibility timeout de 30s, retry do próprio provedor) com folga. Não é longo a ponto de deixar o provedor sem resposta definitiva por muito tempo, nem de acumular pendências. É configurável (`PENDING_REFERENCE_*`).

## 9. Inbox, outbox, retry e DLQ

### Inbox (consumidor)

Tabela `inbox_messages` com PK `(consumer_name, message_id)`. O `INSERT ... ON CONFLICT DO NOTHING` acontece **na mesma transação** da alteração de negócio:

- Commitou → a mensagem está marcada como processada. Se o worker morrer antes do `DeleteMessage`, a redelivery bate no inbox e é só ack (`duplicate`). Testado em `crash-recovery.test.ts` separando `decide()` (processa) de `apply()` (ack/retry/DLQ).
- Não commitou → nada foi gravado, nem o inbox; a redelivery processa normalmente.
- Mesmo `messageId` com payload diferente → `InboxPayloadConflictError` → DLQ (alguém está reutilizando ids, isso precisa de humano).

Inbox e idempotência são complementares: o inbox deduplica **entrega** (mesma mensagem), a idempotency key deduplica **operação de negócio** (mesma transação reenviada com outro `messageId`, ou chegando por HTTP e por fila).

### Outbox (produtor)

Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados em `outbox_messages` **na mesma transação** da mudança de saldo. Nunca existe "saldo mudou mas o evento se perdeu" nem "evento publicado de algo que deu rollback".

O publisher roda em todas as instâncias e faz claim com lease:

```sql
UPDATE outbox_messages SET locked_by = $owner, locked_until = now() + lease
 WHERE id IN (SELECT id FROM outbox_messages
               WHERE published_at IS NULL AND next_attempt_at <= now()
                 AND (locked_until IS NULL OR locked_until < now())
               ORDER BY occurred_at, id LIMIT $n FOR UPDATE SKIP LOCKED)
RETURNING ...;
```

- `SKIP LOCKED`: instâncias pegam lotes disjuntos sem se bloquear.
- Lease: se a instância morrer com o lote na mão, ele volta a ficar disponível quando `locked_until` passa.
- Usa `now()` do banco, não o relógio da instância (sem problema de clock skew).
- Falha ao publicar → `next_attempt_at` com backoff (1s até 5 min), nunca desiste; `last_error` guardado.
- Entrega **at-least-once**. A duplicata (publicou, morreu antes de marcar `published_at`) é absorvida porque `MessageDeduplicationId = eventId` na fila FIFO (janela de 5 min), e os consumidores devem deduplicar por `eventId` de qualquer forma.
- `MessageGroupId = walletId` → eventos de uma carteira saem em ordem.
- Métricas: `wagering_outbox_pending` e `wagering_outbox_lag_seconds` (idade do evento mais antigo não publicado).

### Retry e DLQ (consumidor SQS)

| Classe de erro | Ação |
|---|---|
| sucesso, rejeição de negócio, duplicata | `DeleteMessage` (ack) — rejeição é resultado válido, não erro |
| permanente: payload inválido, `IdempotencyConflict`, `InboxPayloadConflict`, `WalletNotFound`, `ForbiddenProvider` | envia para a DLQ com atributo `failureReason` e apaga da fila principal |
| transitório: lock timeout, conexão, `ConcurrentWriteConflict` | `ChangeMessageVisibility` com backoff `base × 2^(n−1)` limitado ao máximo |
| `ApproximateReceiveCount ≥ SQS_MAX_RECEIVES` | DLQ com `MAX_RECEIVES_EXCEEDED` |

A redrive policy nativa da fila usa `maxReceiveCount = SQS_MAX_RECEIVES + 1` como **rede de segurança**: se o processo morrer antes de conseguir mover para a DLQ, o SQS move sozinho.

**Shutdown gracioso:** em `SIGTERM` o consumidor aborta o long poll, devolve à fila (visibility 0) mensagens recebidas e ainda não iniciadas, e espera as que estão em processamento até `SHUTDOWN_TIMEOUT_MS`.

## 10. Autenticação e autorização (desenho)

Não implementado com um IdP real para manter o escopo, mas o ponto de extensão existe e está no caminho de todas as requisições:

- `ProviderIdentityPort.authenticate(request) → ProviderPrincipal`
- `ProviderAuthGuard` global (rotas de health/metrics marcadas com `@Public()`)
- `ProviderPrincipal.assertCanActFor(providerId)` chamado no controller: um provedor só pode enviar/consultar transações do **próprio** `providerId` → 403 `FORBIDDEN_PROVIDER`.
- Implementação atual: `AllowAllProviderIdentity` (desenvolvimento).

**Desenho para produção (Keycloak / OIDC):**

1. Cada provedor de jogos é um **client** no Keycloak com fluxo **client credentials** (máquina-a-máquina).
2. O token JWT carrega `azp`/`client_id` e um claim `provider_id` (protocol mapper) + roles (`wagering:write`, `wagering:read`, `wallets:admin`).
3. `JwtProviderIdentity` implementa a porta: valida assinatura via JWKS (cache com rotação de chaves), `iss`, `aud`, `exp`/`nbf` com tolerância pequena de clock.
4. Para o canal SQS, a autorização é feita na infraestrutura (IAM policy por fila/conta do provedor) e, se necessário, assinatura do envelope.
5. mTLS entre provedor e gateway como camada adicional; rate limit por `provider_id` no gateway.

## 11. Observabilidade

- **Logs:** pino JSON, um por linha, com `instanceId`, `correlationId`, `transactionId`, `walletId`, `messageId`. Os campos `money`, `balance`, `payload`, `body` e `headers.authorization` são substituídos por `[redacted]` (redact do pino), então valores e payloads financeiros não vão para o log.
- **Correlation id:** header `x-correlation-id` (gerado se ausente, devolvido na resposta). Todo evento de outbox carrega `correlationId` e `causationId` (o `messageId` SQS de origem, ou o id da transação pendente quando quem gerou o evento foi o worker de referências).
- **Métricas Prometheus** (`/metrics`, registry próprio por instância):

| Métrica | Tipo | Uso |
|---|---|---|
| `wagering_transactions_total{kind,status}` | counter | volume e taxa de rejeição |
| `wagering_processing_duration_seconds{source,outcome}` | histogram | p50/p95/p99 |
| `wagering_duplicates_detected_total{source}` | counter | replays (idempotency key) e redeliveries (inbox) |
| `wagering_idempotency_conflicts_total{reason}` | counter | provedor com bug |
| `wagering_lock_conflicts_total{type}` | counter | contenção na carteira quente |
| `wagering_retries_total{component}` | counter | instabilidade de infra |
| `wagering_dlq_messages_total{reason}` | counter | alerta: deve ser ~0 |
| `wagering_outbox_pending`, `wagering_outbox_lag_seconds` | gauge | alerta: lag crescente = publisher parado |
| `wagering_outbox_published_total` | counter | throughput de eventos |
| `wagering_reconciliations_total{result}` | counter | alerta: qualquer `inconsistent` |

- **Health:** `/health/live` (processo) e `/health/ready` (Postgres + SQS com timeout de 2s) — readiness tira a instância do balanceador sem matá-la.
- **Reconciliação:** `POST /wallets/:id/reconciliation` compara saldo com a soma do ledger num snapshot REPEATABLE READ.

## 12. Escalabilidade horizontal

- Instâncias são **stateless**: todo estado (idempotência, inbox, outbox, pendências) está no Postgres.
- Qualquer instância pode atender qualquer carteira; a serialização é feita pelo lock de linha.
- Consumidores SQS competem pela fila; a FIFO com `MessageGroupId = walletId` entrega uma carteira de cada vez por grupo, reduzindo a contenção de lock, enquanto carteiras diferentes andam em paralelo.
- Workers de outbox e pendências rodam em todas as instâncias sem eleição de líder (`SKIP LOCKED` + lock da carteira).
- Gargalo esperado: escrita no Postgres numa carteira muito quente (serial por definição). Mitigações fora do escopo: particionar por carteira, PgBouncer em transaction mode, réplicas de leitura para consultas.

## 13. Teste de carga — metodologia

`scripts/load-test.ts` dispara `LOAD_REQUESTS` requisições com `LOAD_CONCURRENCY` em paralelo, distribuídas em round-robin entre as instâncias, com:

- `LOAD_HOT_WALLET_SHARE` (20%) do tráfego numa única carteira (contenção),
- `LOAD_DUPLICATE_SHARE` (5%) reenviando requisições já feitas (idempotência sob carga),
- mistura BET/WIN.

No fim grava `load-test-results.json` com p50/p95/p99, throughput, taxa de erro, conflitos de lock (métrica), duplicatas detectadas e lag do outbox, junto com CPU/memória da máquina. A consistência é auditada depois, por SQL, em todas as carteiras.

### Resultados

**Ambiente:** 3 instâncias (`docker compose up --build`), Postgres 16 e LocalStack 3.8 na mesma máquina — Intel Core i5-12400F (12 threads), 32 GB RAM, Windows 11 + Docker Desktop/WSL2, Bun 1.4.4.

**Carga:** 5.000 requisições, 50 concorrentes, 50 carteiras, 20% numa carteira quente, 5% duplicatas. Duas rodadas com a mesma configuração, em dias diferentes; `load-test-results.json` guarda a mais recente.

| Métrica | Rodada 1 (2026-11-10) | Rodada 2 (2026-11-11) |
|---|---|---|
| Duração | 26,7 s | 23,2 s |
| Throughput | 187 req/s | 215 req/s |
| Latência p50 | 45 ms | 37 ms |
| Latência p95 | 1.320 ms | 1.336 ms |
| Latência p99 | 1.838 ms | 1.605 ms |
| Taxa de erro | 0% (4.772 × 201, 228 × 200 replay) | 0% (4.763 × 201, 237 × 200 replay) |
| Duplicatas detectadas | 228 (todas replay, nenhum débito duplo) | 237 (todas replay, nenhum débito duplo) |
| Conflitos de lock (timeout/unique) | 0 | 0 |
| Lag do outbox no fim da carga | 9,7 s (zerado logo depois) | 8,9 s (zerado logo depois) |

A diferença entre as rodadas está dentro do ruído de uma máquina compartilhada; o formato se repete: mediana baixa, cauda puxada pela carteira quente, nenhum erro.

**Auditoria pós-carga (SQL em todas as carteiras do banco):** 0 divergências entre saldo e soma do ledger, 0 divergências entre saldo e último `balance_after`, 0 saldos negativos, 0 idempotency keys duplicadas, 0 eventos pendentes na outbox — 56 carteiras após a rodada 1 e 139 após a rodada 2 (o banco também tinha carteiras de testes e demonstrações).

**Leitura dos números:** a mediana de 37–45 ms mostra o custo normal de uma transação (lock + 4 a 6 escritas + commit). A cauda (p95/p99 > 1 s) é a carteira quente: 20% de todo o tráfego disputa **uma única linha**, então essas requisições fazem fila no `FOR UPDATE` — é o comportamento esperado do lock pessimista (serializar em vez de falhar), e nenhuma delas estourou o `lock_timeout`. Carteiras normais não sofrem essa espera. O lag do outbox cresce durante o pico porque o publisher compete por conexões com o tráfego de escrita, e se recupera em segundos quando a carga cai.

**Limitações da medição:** tudo roda numa única máquina (gerador de carga, 3 instâncias, banco e SQS emulado competem pela mesma CPU) via Docker Desktop no Windows, que adiciona overhead de virtualização e de rede. Os números servem para comparar mudanças e mostrar o comportamento sob contenção, não como capacidade de produção.

## 14. Limitações conhecidas e próximos passos

- Autenticação real (seção 10) não implementada — só o ponto de extensão.
- Uma moeda por carteira; não há câmbio.
- Sem particionamento/sharding de banco; carteira quente é limitada pela latência de commit do Postgres.
- `inbox_messages` e `outbox_messages` publicados crescem indefinidamente: em produção, job de limpeza por idade (ex.: manter 7 dias, maior que a janela de redelivery).
- Retenção da DLQ de 14 dias; não há ferramenta de redrive automatizada (usar o redrive do console/CLI da AWS após análise).
- Consumidores dos eventos de saída precisam deduplicar por `eventId` (at-least-once).
- LocalStack fixado em 3.8 porque imagens mais novas exigem token de autenticação.
