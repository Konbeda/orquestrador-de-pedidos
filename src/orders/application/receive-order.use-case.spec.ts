import { InMemoryOrderRepository } from '../../../test/fakes/in-memory-order.repository.js';
import { FakeEnrichmentQueue } from '../../../test/fakes/fake-enrichment.queue.js';
import { FakeSupportedCurrencies } from '../../../test/fakes/fake-supported-currencies.js';
import {
  Order,
  OrderBeingProcessedError,
  RevisionLimitReachedError,
} from '../domain/order.js';
import { FailureReason, OrderStatus } from '../domain/order-status.js';
import { ConcurrentUpdateError } from './ports/order.repository.js';
import {
  IdempotencyKeyReusedError,
  OrderAlreadyExistsError,
  ReceiveOrder,
  type ReceiveOrderCommand,
  type ReceiveOrderSettings,
} from './receive-order.use-case.js';

const command = (
  overrides: Partial<ReceiveOrderCommand> = {},
): ReceiveOrderCommand => ({
  orderId: 'ext-123',
  idempotencyKey: 'key-1',
  customer: { email: 'user@example.com', name: 'Ana' },
  items: [{ sku: 'ABC123', qty: 2, unitPrice: 59.9 }],
  currency: 'USD',
  requestId: 'req_1',
  ...overrides,
});

describe('ReceiveOrder', () => {
  let repository: InMemoryOrderRepository;
  let queue: FakeEnrichmentQueue;

  const useCase = (settings: Partial<ReceiveOrderSettings> = {}) =>
    new ReceiveOrder(repository, queue, new FakeSupportedCurrencies(), {
      duplicatePolicy: 'reject',
      maxRevisions: 10,
      ...settings,
    });

  /** Stores an order received earlier and walks it to `status`. */
  async function existingOrder(
    status: OrderStatus = OrderStatus.RECEIVED,
  ): Promise<Order> {
    const order = Order.receive(command());
    if (status !== OrderStatus.RECEIVED) order.startEnrichment();
    if (status === OrderStatus.ENRICHED) {
      order.completeEnrichment({
        targetCurrency: 'BRL',
        rate: 5,
        rateDate: '2026-11-10',
      });
    }
    if (status === OrderStatus.FAILED_ENRICHMENT) {
      order.failEnrichment(FailureReason.PROVIDER_UNAVAILABLE, {
        retryable: true,
      });
    }
    return repository.seed(order);
  }

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    queue = new FakeEnrichmentQueue();
  });

  describe('a new order', () => {
    it('is stored as RECEIVED and enqueued with the idempotency key as jobId', async () => {
      const result = await useCase().execute(command());

      expect(result.outcome).toBe('created');
      expect(result.order.status).toBe(OrderStatus.RECEIVED);
      expect(repository.all()).toHaveLength(1);
      expect(queue.jobs).toEqual([
        { jobId: 'key-1', orderId: result.order.id, requestId: 'req_1' },
      ]);
    });

    it('with an unsupported currency is stored as FAILED_ENRICHMENT and never enqueued', async () => {
      const result = await useCase().execute(command({ currency: 'ARS' }));

      expect(result.outcome).toBe('created');
      expect(result.order.status).toBe(OrderStatus.FAILED_ENRICHMENT);
      expect(result.order.failure).toEqual({
        reason: FailureReason.UNSUPPORTED_CURRENCY,
        retryable: false,
      });
      expect(queue.jobs).toHaveLength(0);
    });
  });

  describe('the same idempotency key again (client retry)', () => {
    it('returns the stored order as a duplicate without storing or enqueuing anything new', async () => {
      const first = await useCase().execute(command());

      const second = await useCase().execute(command());

      expect(second.outcome).toBe('duplicate');
      expect(second.order.id).toBe(first.order.id);
      expect(repository.all()).toHaveLength(1);
      expect(queue.jobs).toHaveLength(1);
    });

    it('repairs a failed enqueue: the retry of a RECEIVED order enqueues it', async () => {
      queue.failNext();
      await expect(useCase().execute(command())).rejects.toThrow(
        'Redis unavailable',
      );
      expect(repository.all()[0]!.status).toBe(OrderStatus.RECEIVED);
      expect(queue.jobs).toHaveLength(0);

      const retry = await useCase().execute(command());

      expect(retry.outcome).toBe('duplicate');
      expect(queue.jobs).toEqual([
        { jobId: 'key-1', orderId: retry.order.id, requestId: 'req_1' },
      ]);
    });

    it.each([
      OrderStatus.ENRICHING,
      OrderStatus.ENRICHED,
      OrderStatus.FAILED_ENRICHMENT,
    ])('does not enqueue again an order that is %s', async (status) => {
      await existingOrder(status);

      const result = await useCase().execute(command());

      expect(result.outcome).toBe('duplicate');
      expect(queue.jobs).toHaveLength(0);
    });

    it('refuses the key when it arrives with a different order_id', async () => {
      await existingOrder();

      await expect(
        useCase().execute(command({ orderId: 'ext-999' })),
      ).rejects.toThrow(IdempotencyKeyReusedError);
    });
  });

  describe('the same order_id with a new key, policy=reject', () => {
    it('refuses it and keeps the stored order unchanged', async () => {
      const stored = await existingOrder();

      await expect(
        useCase().execute(
          command({
            idempotencyKey: 'key-2',
            items: [{ sku: 'X', qty: 1, unitPrice: 1 }],
          }),
        ),
      ).rejects.toThrow(OrderAlreadyExistsError);

      expect(repository.all()[0]!.toSnapshot()).toEqual(stored.toSnapshot());
      expect(queue.jobs).toHaveLength(0);
    });
  });

  describe('the same order_id with a new key, policy=update', () => {
    const update = command({
      idempotencyKey: 'key-2',
      requestId: 'req_2',
      items: [{ sku: 'ABC123', qty: 5, unitPrice: 10 }],
    });
    const updating = () => useCase({ duplicatePolicy: 'update' });

    it('updates a RECEIVED order without a new job (the queued one reads the new version)', async () => {
      await existingOrder(OrderStatus.RECEIVED);

      const result = await updating().execute(update);

      expect(result.outcome).toBe('updated');
      expect(result.order.revision).toBe(2);
      expect(repository.all()[0]!.total).toBe(50);
      expect(queue.jobs).toHaveLength(0);
    });

    it.each([OrderStatus.ENRICHED, OrderStatus.FAILED_ENRICHMENT])(
      'sends a %s order back to the queue under the new key',
      async (status) => {
        const stored = await existingOrder(status);

        const result = await updating().execute(update);

        expect(result.outcome).toBe('updated');
        expect(result.order.status).toBe(OrderStatus.RECEIVED);
        expect(queue.jobs).toEqual([
          { jobId: 'key-2', orderId: stored.id, requestId: 'req_2' },
        ]);
      },
    );

    it('marks the order FAILED_ENRICHMENT when the update brings an unsupported currency', async () => {
      await existingOrder(OrderStatus.ENRICHED);

      const result = await updating().execute({ ...update, currency: 'ARS' });

      expect(result.order.status).toBe(OrderStatus.FAILED_ENRICHMENT);
      expect(result.order.failure?.reason).toBe(
        FailureReason.UNSUPPORTED_CURRENCY,
      );
      expect(queue.jobs).toHaveLength(0);
    });

    it('refuses while the order is ENRICHING', async () => {
      await existingOrder(OrderStatus.ENRICHING);

      await expect(updating().execute(update)).rejects.toThrow(
        OrderBeingProcessedError,
      );
    });

    it('refuses past MAX_ORDER_REVISIONS', async () => {
      await existingOrder(OrderStatus.RECEIVED);

      await expect(
        useCase({ duplicatePolicy: 'update', maxRevisions: 1 }).execute(update),
      ).rejects.toThrow(RevisionLimitReachedError);
    });
  });

  describe('races between concurrent requests', () => {
    it('two identical requests at once: the loser answers as a duplicate of the winner', async () => {
      repository.simulateConcurrentInsert(Order.receive(command()));

      const result = await useCase().execute(command());

      expect(result.outcome).toBe('duplicate');
      expect(repository.all()).toHaveLength(1);
    });

    it('same order_id with another key at once, policy=reject: the loser is refused', async () => {
      repository.simulateConcurrentInsert(
        Order.receive(command({ idempotencyKey: 'key-0' })),
      );

      await expect(useCase().execute(command())).rejects.toThrow(
        OrderAlreadyExistsError,
      );
      expect(repository.all()).toHaveLength(1);
    });

    it('two updates of the same order at once: the loser is told to retry', async () => {
      await existingOrder(OrderStatus.ENRICHED);
      repository.simulateConcurrentUpdate();

      await expect(
        useCase({ duplicatePolicy: 'update' }).execute(
          command({ idempotencyKey: 'key-2' }),
        ),
      ).rejects.toThrow(ConcurrentUpdateError);
      expect(queue.jobs).toHaveLength(0);
    });
  });
});
