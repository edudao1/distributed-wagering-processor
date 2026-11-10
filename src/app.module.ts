import type { SQSClient } from "@aws-sdk/client-sqs";
import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { PublishOutboxBatch } from "./application/messaging/publish-outbox";
import type {
  Clock,
  EventPublisher,
  IdGenerator,
  Logger,
  PayloadHasher,
  WageringMetrics,
} from "./application/ports/infrastructure";
import type { OutboxStore, UnitOfWork } from "./application/ports/persistence";
import {
  CLOCK,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  OUTBOX_STORE,
  PAYLOAD_HASHER,
  REFERENCE_RETRY_POLICY,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_HANDLER,
} from "./application/ports/tokens";
import { ProcessWagerTransaction } from "./application/wagering/process-wager-transaction";
import { RetryPendingReferences } from "./application/wagering/retry-pending-references";
import { SettlementRecorder } from "./application/wagering/settlement-recorder";
import { WageringQueries } from "./application/wagering/wagering-queries";
import { CreateWallet } from "./application/wallets/create-wallet";
import { ReconcileWallet } from "./application/wallets/reconcile-wallet";
import { WalletQueries } from "./application/wallets/wallet-queries";
import { APP_CONFIG, type AppConfig } from "./config/app-config";
import { ReferenceRetryPolicy } from "./domain/wagering/reference-retry-policy";
import { Sha256PayloadHasher } from "./infrastructure/hashing/sha256-payload-hasher";
import { createSqsClient, QueueUrlResolver, SQS_CLIENT } from "./infrastructure/messaging/sqs-client";
import { SqsEventPublisher } from "./infrastructure/messaging/sqs-event-publisher";
import { PinoLogger } from "./infrastructure/observability/logger";
import { PrometheusMetrics } from "./infrastructure/observability/prometheus-metrics";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { initOrm, MIKRO_ORM, OrmLifecycle } from "./infrastructure/persistence/orm";
import { MikroOrmOutboxStore } from "./infrastructure/persistence/outbox-store";
import { SystemClock, UuidV7Generator } from "./infrastructure/system/system-adapters";
import { OutboxPublisherWorker, PendingReferenceWorker } from "./infrastructure/workers/workers";
import { AllowAllProviderIdentity, PROVIDER_IDENTITY, ProviderAuthGuard } from "./interfaces/http/auth";
import { HttpErrorFilter } from "./interfaces/http/http-error.filter";
import { OperationsController } from "./interfaces/http/operations.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";
import { WagerTransactionConsumer } from "./interfaces/messaging/wager-transaction.consumer";

function infrastructureProviders(config: AppConfig): Provider[] {
  const metrics = new PrometheusMetrics();
  return [
    { provide: APP_CONFIG, useValue: config },
    { provide: LOGGER, useValue: PinoLogger.create(config) },
    { provide: PrometheusMetrics, useValue: metrics },
    { provide: METRICS, useValue: metrics },
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
    { provide: PAYLOAD_HASHER, useValue: new Sha256PayloadHasher() },
    {
      provide: REFERENCE_RETRY_POLICY,
      useValue: ReferenceRetryPolicy.create({
        maxAttempts: config.pendingReference.maxAttempts,
        baseDelayMs: config.pendingReference.baseDelayMs,
        maxDelayMs: config.pendingReference.maxDelayMs,
      }),
    },
    { provide: MIKRO_ORM, useFactory: () => initOrm(config) },
    OrmLifecycle,
    { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
    { provide: OUTBOX_STORE, useClass: MikroOrmOutboxStore },
    { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.sqs) },
    {
      provide: QueueUrlResolver,
      inject: [SQS_CLIENT],
      useFactory: (client: SQSClient) => new QueueUrlResolver(client, config.sqs.endpoint),
    },
    { provide: EVENT_PUBLISHER, useClass: SqsEventPublisher },
    { provide: PROVIDER_IDENTITY, useValue: new AllowAllProviderIdentity() },
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ];
}

const applicationProviders: Provider[] = [
  {
    provide: SettlementRecorder,
    inject: [ID_GENERATOR, METRICS],
    useFactory: (ids: IdGenerator, metrics: WageringMetrics) => new SettlementRecorder(ids, metrics),
  },
  {
    provide: WAGER_TRANSACTION_HANDLER,
    inject: [UNIT_OF_WORK, PAYLOAD_HASHER, CLOCK, ID_GENERATOR, SettlementRecorder, REFERENCE_RETRY_POLICY, METRICS, LOGGER],
    useFactory: (
      uow: UnitOfWork,
      hasher: PayloadHasher,
      clock: Clock,
      ids: IdGenerator,
      recorder: SettlementRecorder,
      policy: ReferenceRetryPolicy,
      metrics: WageringMetrics,
      logger: Logger,
    ) => new ProcessWagerTransaction(uow, hasher, clock, ids, recorder, policy, metrics, logger),
  },
  {
    provide: RetryPendingReferences,
    inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, SettlementRecorder, REFERENCE_RETRY_POLICY, METRICS, LOGGER],
    useFactory: (
      uow: UnitOfWork,
      clock: Clock,
      ids: IdGenerator,
      recorder: SettlementRecorder,
      policy: ReferenceRetryPolicy,
      metrics: WageringMetrics,
      logger: Logger,
    ) => new RetryPendingReferences(uow, clock, ids, recorder, policy, metrics, logger),
  },
  {
    provide: CreateWallet,
    inject: [UNIT_OF_WORK, PAYLOAD_HASHER, CLOCK, ID_GENERATOR, METRICS, LOGGER],
    useFactory: (
      uow: UnitOfWork,
      hasher: PayloadHasher,
      clock: Clock,
      ids: IdGenerator,
      metrics: WageringMetrics,
      logger: Logger,
    ) => new CreateWallet(uow, hasher, clock, ids, metrics, logger),
  },
  {
    provide: WalletQueries,
    inject: [UNIT_OF_WORK],
    useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
  },
  {
    provide: WageringQueries,
    inject: [UNIT_OF_WORK],
    useFactory: (uow: UnitOfWork) => new WageringQueries(uow),
  },
  {
    provide: ReconcileWallet,
    inject: [UNIT_OF_WORK, METRICS, LOGGER],
    useFactory: (uow: UnitOfWork, metrics: WageringMetrics, logger: Logger) =>
      new ReconcileWallet(uow, metrics, logger),
  },
  {
    provide: PublishOutboxBatch,
    inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, METRICS, LOGGER, APP_CONFIG],
    useFactory: (
      store: OutboxStore,
      publisher: EventPublisher,
      clock: Clock,
      metrics: WageringMetrics,
      logger: Logger,
      config: AppConfig,
    ) =>
      new PublishOutboxBatch(store, publisher, clock, metrics, logger, {
        owner: config.instanceId,
        batchSize: config.outbox.batchSize,
        leaseMs: config.outbox.leaseMs,
      }),
  },
];

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, OperationsController],
      providers: [
        ...infrastructureProviders(config),
        ...applicationProviders,
        WagerTransactionConsumer,
        OutboxPublisherWorker,
        PendingReferenceWorker,
      ],
    };
  }
}
