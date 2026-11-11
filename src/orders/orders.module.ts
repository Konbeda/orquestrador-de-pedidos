import { Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { Env } from '../config/env.schema.js';
import { EnrichOrder } from './application/enrich-order.use-case.js';
import { EnqueueStaleOrders } from './application/enqueue-stale-orders.use-case.js';
import { EnrichmentQueue } from './application/ports/enrichment.queue.js';
import { ExchangeRateProvider } from './application/ports/exchange-rate.provider.js';
import { OrderRepository } from './application/ports/order.repository.js';
import { SupportedCurrencies } from './application/ports/supported-currencies.js';
import { ReceiveOrder } from './application/receive-order.use-case.js';
import { ReprocessOrders } from './application/reprocess-orders.use-case.js';
import { CachedSupportedCurrencies } from './infra/exchange/cached-supported-currencies.js';
import { CircuitBreakingExchangeRateProvider } from './infra/exchange/circuit-breaking.provider.js';
import { FrankfurterClient } from './infra/exchange/frankfurter.client.js';
import { MongoOrderRepository } from './infra/persistence/mongo-order.repository.js';
import {
  ORDER_MODEL,
  OrderSchema,
  type OrderDocument,
} from './infra/persistence/order.schema.js';
import { BullMqEnrichmentQueue } from './infra/queue/bullmq-enrichment.queue.js';
import { EnrichmentWorkerRunner } from './infra/queue/enrichment-worker.runner.js';
import { OrphanSweeperRunner } from './infra/queue/orphan-sweeper.runner.js';
import { WebhooksController } from './http/webhooks.controller.js';
import { OrdersController } from './http/orders.controller.js';

type Config = ConfigService<Env, true>;
const logger = new Logger('OrdersModule');

/*
 * Composition root of the orders feature: ports (abstract classes) are the
 * injection tokens, adapters are built by factories from the validated config.
 * Use cases stay free of Nest decorators.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ORDER_MODEL, schema: OrderSchema }]),
  ],
  controllers: [WebhooksController, OrdersController],
  // Read by the health check (state only, no network round trips).
  exports: [
    CachedSupportedCurrencies,
    CircuitBreakingExchangeRateProvider,
    EnrichmentQueue,
  ],
  providers: [
    {
      provide: OrderRepository,
      inject: [getModelToken(ORDER_MODEL)],
      useFactory: async (model: Model<OrderDocument>) => {
        // Unique indexes must exist before the first write, or two identical
        // requests could both be stored. Nest awaits this before serving traffic.
        await model.init();
        return new MongoOrderRepository(model);
      },
    },
    {
      provide: BullMqEnrichmentQueue,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        new BullMqEnrichmentQueue({
          host: config.get('REDIS_HOST', { infer: true }),
          port: config.get('REDIS_PORT', { infer: true }),
          commandTimeoutMs: config.get('REDIS_COMMAND_TIMEOUT_MS', {
            infer: true,
          }),
          attempts: config.get('ENRICHMENT_MAX_ATTEMPTS', { infer: true }),
          backoffMs: config.get('ENRICHMENT_BACKOFF_MS', { infer: true }),
        }),
    },
    { provide: EnrichmentQueue, useExisting: BullMqEnrichmentQueue },
    {
      provide: FrankfurterClient,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        new FrankfurterClient({
          baseUrl: config.get('FRANKFURTER_BASE_URL', { infer: true }),
          timeoutMs: config.get('FRANKFURTER_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: CachedSupportedCurrencies,
      inject: [FrankfurterClient, ConfigService],
      useFactory: async (frankfurter: FrankfurterClient, config: Config) => {
        const currencies = new CachedSupportedCurrencies(frankfurter, {
          ttlMs: config.get('SUPPORTED_CURRENCIES_TTL_MS', { infer: true }),
          retryAfterFailureMs: 60_000,
          fallback: config.get('SUPPORTED_CURRENCIES_FALLBACK', {
            infer: true,
          }),
        });
        // Boot never fails on Frankfurter: degraded, not down.
        const source = await currencies.warmUp();
        if (source === 'fallback') {
          logger.warn(
            'Frankfurter unreachable at boot: using SUPPORTED_CURRENCIES_FALLBACK',
          );
        }
        return currencies;
      },
    },
    { provide: SupportedCurrencies, useExisting: CachedSupportedCurrencies },
    {
      provide: CircuitBreakingExchangeRateProvider,
      inject: [FrankfurterClient, ConfigService],
      useFactory: (frankfurter: FrankfurterClient, config: Config) =>
        new CircuitBreakingExchangeRateProvider(frankfurter, {
          failureThreshold: config.get('CIRCUIT_FAILURE_THRESHOLD', {
            infer: true,
          }),
          resetTimeoutMs: config.get('CIRCUIT_RESET_TIMEOUT_MS', {
            infer: true,
          }),
          onStateChange: (state) =>
            state === 'closed'
              ? logger.log('Frankfurter circuit closed: calls resumed')
              : logger.warn(`Frankfurter circuit ${state}`),
        }),
    },
    {
      provide: ExchangeRateProvider,
      useExisting: CircuitBreakingExchangeRateProvider,
    },
    {
      provide: EnrichOrder,
      inject: [OrderRepository, ExchangeRateProvider, ConfigService],
      useFactory: (
        orders: OrderRepository,
        provider: ExchangeRateProvider,
        config: Config,
      ) =>
        new EnrichOrder(orders, provider, {
          targetCurrency: config.get('ENRICHMENT_TARGET_CURRENCY', {
            infer: true,
          }),
        }),
    },
    EnrichmentWorkerRunner,
    {
      provide: EnqueueStaleOrders,
      inject: [OrderRepository, EnrichmentQueue, ConfigService],
      useFactory: (
        orders: OrderRepository,
        queue: EnrichmentQueue,
        config: Config,
      ) =>
        new EnqueueStaleOrders(orders, queue, {
          staleAfterMs: config.get('STALE_ORDER_AFTER_MS', { infer: true }),
          batchSize: config.get('SWEEP_BATCH_SIZE', { infer: true }),
        }),
    },
    OrphanSweeperRunner,
    {
      provide: ReprocessOrders,
      inject: [OrderRepository, EnrichmentQueue, ConfigService],
      useFactory: (
        orders: OrderRepository,
        queue: EnrichmentQueue,
        config: Config,
      ) =>
        new ReprocessOrders(orders, queue, {
          maxReprocessCount: config.get('REPROCESS_MAX_COUNT', { infer: true }),
        }),
    },
    {
      provide: ReceiveOrder,
      inject: [
        OrderRepository,
        EnrichmentQueue,
        SupportedCurrencies,
        ConfigService,
      ],
      useFactory: (
        orders: OrderRepository,
        queue: EnrichmentQueue,
        currencies: SupportedCurrencies,
        config: Config,
      ) =>
        new ReceiveOrder(orders, queue, currencies, {
          duplicatePolicy: config.get('ORDER_DUPLICATE_POLICY', {
            infer: true,
          }),
          maxRevisions: config.get('MAX_ORDER_REVISIONS', { infer: true }),
          enqueueRetryDelaysMs: config.get('ENQUEUE_RETRY_DELAYS_MS', {
            infer: true,
          }),
        }),
    },
  ],
})
export class OrdersModule implements OnApplicationShutdown {
  constructor(private readonly queue: BullMqEnrichmentQueue) {}

  /** Factory-built adapters get no lifecycle hooks of their own: close them here. */
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
