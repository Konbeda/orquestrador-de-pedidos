import { InMemoryOrderRepository } from '../../../test/fakes/in-memory-order.repository.js';
import { FakeExchangeRateProvider } from '../../../test/fakes/fake-exchange-rate.provider.js';
import { Order, type NewOrderProps } from '../domain/order.js';
import { FailureReason, OrderStatus } from '../domain/order-status.js';
import {
  ProviderRejectedError,
  ProviderUnavailableError,
} from './ports/exchange-rate.provider.js';
import {
  EnrichOrder,
  EnrichmentFailed,
  ExchangeProviderPaused,
  RetryEnrichmentLater,
  type EnrichOrderCommand,
} from './enrich-order.use-case.js';

const props = (overrides: Partial<NewOrderProps> = {}): NewOrderProps => ({
  orderId: 'ext-123',
  idempotencyKey: 'key-1',
  customer: { email: 'user@example.com', name: 'Ana' },
  items: [{ sku: 'ABC123', qty: 2, unitPrice: 59.9 }], // total 119.80
  currency: 'USD',
  ...overrides,
});

describe('EnrichOrder', () => {
  let repository: InMemoryOrderRepository;
  let provider: FakeExchangeRateProvider;
  let order: Order;

  const enrich = () =>
    new EnrichOrder(repository, provider, { targetCurrency: 'BRL' });
  const command = (
    overrides: Partial<EnrichOrderCommand> = {},
  ): EnrichOrderCommand => ({
    orderId: order.id!,
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  });
  const stored = async () => (await repository.findById(order.id!))!;

  beforeEach(async () => {
    repository = new InMemoryOrderRepository();
    provider = new FakeExchangeRateProvider();
    order = await repository.seed(Order.receive(props()));
  });

  describe('success', () => {
    it('converts the total to the target currency and stores the order as ENRICHED', async () => {
      const result = await enrich().execute(command());

      expect(result).toEqual({ outcome: 'enriched' });
      expect(provider.calls).toEqual([{ from: 'USD', to: 'BRL' }]);
      const saved = await stored();
      expect(saved.status).toBe(OrderStatus.ENRICHED);
      expect(saved.enrichment).toEqual({
        targetCurrency: 'BRL',
        rate: 5.5,
        rateDate: '2026-11-10',
        convertedTotal: 658.9,
      });
    });

    it('stores ENRICHING before calling the provider, so updates know it is being processed', async () => {
      let statusDuringCall: OrderStatus | undefined;
      provider.onCall = async () => {
        statusDuringCall = (await stored()).status;
      };

      await enrich().execute(command());

      expect(statusDuringCall).toBe(OrderStatus.ENRICHING);
    });

    it('does not call the provider when the order is already in the target currency', async () => {
      order = await repository.seed(
        Order.receive(
          props({
            orderId: 'ext-brl',
            idempotencyKey: 'key-brl',
            currency: 'BRL',
          }),
        ),
      );

      await enrich().execute(command());

      expect(provider.calls).toHaveLength(0);
      expect((await stored()).enrichment).toMatchObject({
        rate: 1,
        convertedTotal: 119.8,
      });
    });

    it('resumes an order a previous attempt left ENRICHING', async () => {
      provider.failWith(new ProviderUnavailableError('timeout'), 1);
      await expect(enrich().execute(command({ attempt: 1 }))).rejects.toThrow(
        RetryEnrichmentLater,
      );

      await enrich().execute(command({ attempt: 2 }));

      expect((await stored()).status).toBe(OrderStatus.ENRICHED);
    });
  });

  describe('nothing to do (worker idempotency)', () => {
    it('skips an order that is already final, without calling the provider', async () => {
      await enrich().execute(command());
      provider.calls.length = 0;

      const again = await enrich().execute(command());

      expect(again).toEqual({ outcome: 'skipped', reason: 'already_final' });
      expect(provider.calls).toHaveLength(0);
    });

    it('skips a job whose order does not exist', async () => {
      const result = await enrich().execute(command({ orderId: 'missing' }));

      expect(result).toEqual({ outcome: 'skipped', reason: 'not_found' });
    });
  });

  describe('temporary failures', () => {
    it('asks for a retry while attempts remain, keeping the order ENRICHING', async () => {
      provider.failWith(new ProviderUnavailableError('503'));

      await expect(enrich().execute(command({ attempt: 2 }))).rejects.toThrow(
        RetryEnrichmentLater,
      );

      expect((await stored()).status).toBe(OrderStatus.ENRICHING);
    });

    it('on the last attempt marks FAILED_ENRICHMENT as retryable (provider down)', async () => {
      provider.failWith(new ProviderUnavailableError('timeout'));

      await expect(enrich().execute(command({ attempt: 3 }))).rejects.toThrow(
        EnrichmentFailed,
      );

      expect((await stored()).failure).toEqual({
        reason: FailureReason.PROVIDER_UNAVAILABLE,
        retryable: true,
      });
    });

    it('treats our own unexpected errors as temporary, failing as INTERNAL_ERROR on the last attempt', async () => {
      provider.failWith(new TypeError('bug'));

      await expect(enrich().execute(command({ attempt: 1 }))).rejects.toThrow(
        RetryEnrichmentLater,
      );
      await expect(enrich().execute(command({ attempt: 3 }))).rejects.toThrow(
        EnrichmentFailed,
      );

      expect((await stored()).failure).toEqual({
        reason: FailureReason.INTERNAL_ERROR,
        retryable: true,
      });
    });

    it('retries when the client updated the order between the read and the save', async () => {
      repository.simulateConcurrentUpdate();

      await expect(enrich().execute(command())).rejects.toThrow(
        RetryEnrichmentLater,
      );
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe('database failures while saving', () => {
    const hiccup = () => new Error('mongo hiccup');

    it('records the failure from a fresh read when saving the ENRICHED result fails on the last attempt', async () => {
      // 1st update (ENRICHING) passes, 2nd (ENRICHED) fails, 3rd (FAILED) passes.
      repository.planUpdateFailures([null, hiccup(), null]);

      await expect(enrich().execute(command({ attempt: 3 }))).rejects.toThrow(
        EnrichmentFailed,
      );

      expect((await stored()).failure).toEqual({
        reason: FailureReason.INTERNAL_ERROR,
        retryable: true,
      });
    });

    it('still ends the job as failed when even the failure cannot be saved (order stays ENRICHING)', async () => {
      repository.planUpdateFailures([null, hiccup(), hiccup()]);

      await expect(enrich().execute(command({ attempt: 3 }))).rejects.toThrow(
        EnrichmentFailed,
      );

      expect((await stored()).status).toBe(OrderStatus.ENRICHING);
    });
  });

  describe('permanent failures', () => {
    it('fails at once, even on the first attempt, as non retryable', async () => {
      provider.failWith(new ProviderRejectedError('422 invalid currency'));

      await expect(enrich().execute(command({ attempt: 1 }))).rejects.toThrow(
        EnrichmentFailed,
      );

      const saved = await stored();
      expect(saved.status).toBe(OrderStatus.FAILED_ENRICHMENT);
      expect(saved.failure).toEqual({
        reason: FailureReason.PROVIDER_REJECTED,
        retryable: false,
      });
    });
  });

  describe('provider paused (circuit open)', () => {
    it('touches nothing and asks for the job to wait, without spending an attempt', async () => {
      provider.openCircuit();

      await expect(enrich().execute(command())).rejects.toThrow(
        ExchangeProviderPaused,
      );

      expect(provider.calls).toHaveLength(0);
      expect((await stored()).status).toBe(OrderStatus.RECEIVED);
    });

    it('still skips a final order when the circuit is open (nothing to wait for)', async () => {
      await enrich().execute(command());
      provider.openCircuit();

      expect(await enrich().execute(command())).toEqual({
        outcome: 'skipped',
        reason: 'already_final',
      });
    });
  });
});
