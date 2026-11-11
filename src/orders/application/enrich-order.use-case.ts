import type { Order } from '../domain/order.js';
import { FailureReason } from '../domain/order-status.js';
import {
  ExchangeRateProvider,
  ProviderRejectedError,
  ProviderUnavailableError,
  type ExchangeRate,
} from './ports/exchange-rate.provider.js';
import {
  ConcurrentUpdateError,
  OrderRepository,
} from './ports/order.repository.js';

export interface EnrichOrderCommand {
  /** Internal (database) id carried by the job. */
  orderId: string;
  /** 1-based attempt number of this job run. */
  attempt: number;
  maxAttempts: number;
}

export interface EnrichOrderSettings {
  targetCurrency: string;
}

export type EnrichOrderResult =
  | { outcome: 'enriched' }
  | { outcome: 'skipped'; reason: 'not_found' | 'already_final' };

/*
 * How the run ended when it did not succeed. The worker adapter maps each one
 * onto BullMQ; the use case itself knows nothing about queues.
 */

/** Temporary failure with attempts left: retry with backoff. */
export class RetryEnrichmentLater extends Error {
  override name = 'RetryEnrichmentLater';
  constructor(override readonly cause: unknown) {
    super(`Enrichment will be retried: ${describe(cause)}`);
  }
}

/** Final: permanent failure, or the last attempt failed. The order is FAILED_ENRICHMENT. */
export class EnrichmentFailed extends Error {
  override name = 'EnrichmentFailed';
  constructor(
    readonly reason: FailureReason,
    override readonly cause: unknown,
  ) {
    super(`Enrichment failed (${reason}): ${describe(cause)}`);
  }
}

/** Provider known to be down (circuit open): nothing was touched; the job should wait. */
export class ExchangeProviderPaused extends Error {
  override name = 'ExchangeProviderPaused';
  constructor() {
    super('Exchange rate provider is paused (circuit open)');
  }
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Worker side: converts the order total with the exchange rate provider.
 *
 *   job → load → (final? skip) → ENRICHING → provider → ENRICHED
 *                                                    ↘ retry later / FAILED_ENRICHMENT
 */
export class EnrichOrder {
  constructor(
    private readonly orders: OrderRepository,
    private readonly provider: ExchangeRateProvider,
    private readonly settings: EnrichOrderSettings,
  ) {}

  async execute(command: EnrichOrderCommand): Promise<EnrichOrderResult> {
    const order = await this.orders.findById(command.orderId);
    if (!order) return { outcome: 'skipped', reason: 'not_found' };
    // A redelivered or duplicate job for an order that already finished: no-op.
    if (!order.needsEnrichment)
      return { outcome: 'skipped', reason: 'already_final' };

    const needsProvider = order.currency !== this.settings.targetCurrency;
    if (needsProvider && !this.provider.isAvailable()) {
      throw new ExchangeProviderPaused();
    }

    const revision = order.revision;
    order.startEnrichment();
    try {
      await this.orders.update(order, revision);
    } catch (error) {
      // The client changed the order since we read it: start over with the new data.
      // On the last attempt the job fails while the order is still RECEIVED,
      // so the orphan sweeper enqueues it again.
      if (error instanceof ConcurrentUpdateError)
        throw new RetryEnrichmentLater(error);
      throw error;
    }

    try {
      const { rate, date } = needsProvider
        ? await this.provider.getRate(
            order.currency,
            this.settings.targetCurrency,
          )
        : this.identityRate();
      order.completeEnrichment({
        targetCurrency: this.settings.targetCurrency,
        rate,
        rateDate: date,
      });
      await this.orders.update(order, revision);
      return { outcome: 'enriched' };
    } catch (error) {
      return this.fail(command, error);
    }
  }

  private async fail(
    command: EnrichOrderCommand,
    error: unknown,
  ): Promise<never> {
    const { reason, retryable, final } = this.classify(error, command);
    if (!final) throw new RetryEnrichmentLater(error);

    // Re-read: the local copy may be half-way (e.g. completed but not saved).
    const order = await this.orders.findById(command.orderId);
    if (order?.needsEnrichment) {
      order.failEnrichment(reason, { retryable });
      await this.saveFailure(order);
    }
    throw new EnrichmentFailed(reason, error);
  }

  private classify(
    error: unknown,
    { attempt, maxAttempts }: EnrichOrderCommand,
  ): { reason: FailureReason; retryable: boolean; final: boolean } {
    const lastAttempt = attempt >= maxAttempts;
    if (error instanceof ProviderRejectedError) {
      return {
        reason: FailureReason.PROVIDER_REJECTED,
        retryable: false,
        final: true,
      };
    }
    if (error instanceof ProviderUnavailableError) {
      return {
        reason: FailureReason.PROVIDER_UNAVAILABLE,
        retryable: true,
        final: lastAttempt,
      };
    }
    return {
      reason: FailureReason.INTERNAL_ERROR,
      retryable: true,
      final: lastAttempt,
    };
  }

  private async saveFailure(order: Order): Promise<void> {
    try {
      await this.orders.update(order, order.revision);
    } catch {
      // Could not record the failure (database down too): the order stays ENRICHING.
      // Known gap, documented: a sweeper for stuck ENRICHING orders would close it.
    }
  }

  private identityRate(): ExchangeRate {
    return { rate: 1, date: new Date().toISOString().slice(0, 10) };
  }
}
