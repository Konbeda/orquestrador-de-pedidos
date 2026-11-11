import { InMemoryOrderRepository } from '../../../test/fakes/in-memory-order.repository.js';
import { FakeEnrichmentQueue } from '../../../test/fakes/fake-enrichment.queue.js';
import { Order, type NewOrderProps } from '../domain/order.js';
import { FailureReason, OrderStatus } from '../domain/order-status.js';
import { ReprocessOrders } from './reprocess-orders.use-case.js';

const props = (n: number): NewOrderProps => ({
  orderId: `ext-${n}`,
  idempotencyKey: `key-${n}`,
  customer: { email: 'user@example.com', name: 'Ana' },
  items: [{ sku: 'ABC123', qty: 1, unitPrice: 10 }],
  currency: 'USD',
});

describe('ReprocessOrders', () => {
  let repository: InMemoryOrderRepository;
  let queue: FakeEnrichmentQueue;

  const reprocess = () =>
    new ReprocessOrders(repository, queue, { maxReprocessCount: 3 });

  /** Stores an order in `status`; failures are retryable unless told otherwise. */
  async function stored(
    n: number,
    status: OrderStatus = OrderStatus.FAILED_ENRICHMENT,
    { retryable = true, reprocessed = 0 } = {},
  ): Promise<string> {
    const order = Order.receive(props(n));
    for (let run = 0; run <= reprocessed; run++) {
      if (status === OrderStatus.RECEIVED) break;
      order.startEnrichment();
      if (status === OrderStatus.ENRICHING) break;
      if (status === OrderStatus.ENRICHED) {
        order.completeEnrichment({
          targetCurrency: 'BRL',
          rate: 5,
          rateDate: '2026-11-10',
        });
        break;
      }
      order.failEnrichment(FailureReason.PROVIDER_UNAVAILABLE, {
        retryable: run < reprocessed ? true : retryable,
      });
      if (run < reprocessed)
        order.requeueForReprocess({ maxReprocessCount: 10 });
    }
    return (await repository.seed(order)).id!;
  }

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    queue = new FakeEnrichmentQueue();
  });

  describe('batch (no ids)', () => {
    it('sends every retryable failure back to RECEIVED and enqueues it with low priority', async () => {
      const a = await stored(1);
      const b = await stored(2);

      const result = await reprocess().execute({
        limit: 100,
        requestId: 'req_r',
      });

      expect(result).toEqual({
        reprocessed: [
          { id: a, pendingEnqueue: false },
          { id: b, pendingEnqueue: false },
        ],
        skipped: [],
      });
      expect(queue.jobs).toEqual([
        {
          jobId: 'key-1#reprocess-1',
          orderId: a,
          requestId: 'req_r',
          priority: 'low',
        },
        {
          jobId: 'key-2#reprocess-1',
          orderId: b,
          requestId: 'req_r',
          priority: 'low',
        },
      ]);
      const order = (await repository.findById(a))!;
      expect(order.status).toBe(OrderStatus.RECEIVED);
      expect(order.reprocessCount).toBe(1);
    });

    it('takes at most `limit` orders, oldest first', async () => {
      const oldest = await stored(1);
      await stored(2);

      const result = await reprocess().execute({
        limit: 1,
        requestId: 'req_r',
      });

      expect(result.reprocessed.map((r) => r.id)).toEqual([oldest]);
    });

    it('leaves out non retryable failures and orders past the reprocess limit', async () => {
      await stored(1, OrderStatus.FAILED_ENRICHMENT, { retryable: false });
      await stored(2, OrderStatus.FAILED_ENRICHMENT, { reprocessed: 3 });

      const result = await reprocess().execute({
        limit: 100,
        requestId: 'req_r',
      });

      expect(result).toEqual({ reprocessed: [], skipped: [] });
    });
  });

  describe('chosen orders (ids)', () => {
    it('reprocesses the given ones and explains each refusal', async () => {
      const ok = await stored(1);
      const notRetryable = await stored(2, OrderStatus.FAILED_ENRICHMENT, {
        retryable: false,
      });
      const exhausted = await stored(3, OrderStatus.FAILED_ENRICHMENT, {
        reprocessed: 3,
      });
      const enriched = await stored(4, OrderStatus.ENRICHED);

      const result = await reprocess().execute({
        orderIds: [ok, notRetryable, exhausted, enriched, 'missing'],
        limit: 100,
        requestId: 'req_r',
      });

      expect(result).toEqual({
        reprocessed: [{ id: ok, pendingEnqueue: false }],
        skipped: [
          { id: notRetryable, reason: 'NOT_RETRYABLE' },
          { id: exhausted, reason: 'LIMIT_REACHED' },
          { id: enriched, reason: 'NOT_FAILED' },
          { id: 'missing', reason: 'NOT_FOUND' },
        ],
      });
      expect(queue.jobs).toHaveLength(1);
    });

    it('skips an order changed concurrently, without enqueuing it', async () => {
      const id = await stored(1);
      repository.simulateConcurrentUpdate();

      const result = await reprocess().execute({
        orderIds: [id],
        limit: 100,
        requestId: 'req_r',
      });

      expect(result.skipped).toEqual([{ id, reason: 'CONCURRENT_UPDATE' }]);
      expect(queue.attempts).toBe(0);
    });
  });

  describe('queue unavailable', () => {
    it('still reprocesses (the order is stored as RECEIVED) and leaves the enqueue to the sweeper', async () => {
      const id = await stored(1);
      queue.failNext(Infinity);

      const result = await reprocess().execute({
        orderIds: [id],
        limit: 100,
        requestId: 'req_r',
      });

      expect(result.reprocessed).toEqual([{ id, pendingEnqueue: true }]);
      expect((await repository.findById(id))!.status).toBe(
        OrderStatus.RECEIVED,
      );
    });
  });
});
