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
  /** Delays the use case waited for, recorded instead of really sleeping. */
  let sleeps: number[];
  /** Runs while the use case "sleeps": lets a test change the world between attempts. */
  let onSleep: (() => void) | undefined;

  const useCase = (settings: Partial<ReceiveOrderSettings> = {}) =>
    new ReceiveOrder(
      repository,
      queue,
      new FakeSupportedCurrencies(),
      {
        duplicatePolicy: 'reject',
        maxRevisions: 10,
        enqueueRetryDelaysMs: [100, 200, 400],
        ...settings,
      },
      async (ms) => {
        sleeps.push(ms);
        onSleep?.();
      },
    );

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
    sleeps = [];
    onSleep = undefined;
  });

  describe('a new order', () => {
    it('is stored as RECEIVED and enqueued with the idempotency key as jobId', async () => {
      const result = await useCase().execute(command());

      expect(result.outcome).toBe('created');
      expect(result.pendingEnqueue).toBe(false);
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

    it('repairs a pending enqueue: the retry of a RECEIVED order enqueues it at once', async () => {
      queue.failNext(Infinity);
      const first = await useCase().execute(command());
      expect(first.pendingEnqueue).toBe(true);
      queue.recover();

      const retry = await useCase().execute(command());

      expect(retry.outcome).toBe('duplicate');
      expect(retry.pendingEnqueue).toBe(false);
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

  describe('when the queue (Redis) fails after the order is stored', () => {
    it('retries the enqueue internally with the configured delays', async () => {
      queue.failNext(2);

      const result = await useCase().execute(command());

      expect(result.pendingEnqueue).toBe(false);
      expect(queue.attempts).toBe(3);
      expect(sleeps).toEqual([100, 200]);
      expect(queue.jobs).toHaveLength(1);
    });

    it('still accepts the order once the retries run out: it is stored and the sweeper will enqueue it', async () => {
      queue.failNext(Infinity);

      const result = await useCase().execute(command());

      expect(result.outcome).toBe('created');
      expect(result.pendingEnqueue).toBe(true);
      expect(result.order.status).toBe(OrderStatus.RECEIVED);
      expect(repository.all()).toHaveLength(1);
      expect(queue.attempts).toBe(4);
      expect(sleeps).toEqual([100, 200, 400]);
    });

    it('also accepts an update whose new job could not be enqueued', async () => {
      await existingOrder(OrderStatus.ENRICHED);
      queue.failNext(Infinity);

      const result = await useCase({ duplicatePolicy: 'update' }).execute(
        command({ idempotencyKey: 'key-2' }),
      );

      expect(result.outcome).toBe('updated');
      expect(result.pendingEnqueue).toBe(true);
      expect(repository.all()[0]!.status).toBe(OrderStatus.RECEIVED);
    });

    it('does not wait nor try when the queue is already known to be down', async () => {
      queue.goOffline();

      const result = await useCase().execute(command());

      expect(result.outcome).toBe('created');
      expect(result.pendingEnqueue).toBe(true);
      expect(result.enqueueError).toBeInstanceOf(Error);
      expect(queue.attempts).toBe(0);
      expect(sleeps).toEqual([]);
    });

    it('stops waiting as soon as the queue becomes known to be down between attempts', async () => {
      queue.failNext(Infinity);
      onSleep = () => queue.goOffline();

      const result = await useCase().execute(command());

      expect(result.pendingEnqueue).toBe(true);
      expect(queue.attempts).toBe(1);
      expect(sleeps).toEqual([100]);
    });

    it('keeps retrying with waits while the queue still looks up (e.g. a frozen Redis timing out)', async () => {
      queue.failNext(Infinity);

      await useCase().execute(command());

      expect(queue.attempts).toBe(4);
      expect(sleeps).toEqual([100, 200, 400]);
    });

    it('does not retry when no enqueue was needed', async () => {
      queue.failNext(Infinity);

      const result = await useCase().execute(command({ currency: 'ARS' }));

      expect(result.pendingEnqueue).toBe(false);
      expect(queue.attempts).toBe(0);
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
