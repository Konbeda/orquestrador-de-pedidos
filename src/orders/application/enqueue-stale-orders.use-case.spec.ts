import { InMemoryOrderRepository } from '../../../test/fakes/in-memory-order.repository.js';
import { FakeEnrichmentQueue } from '../../../test/fakes/fake-enrichment.queue.js';
import { Order, type NewOrderProps } from '../domain/order.js';
import { FailureReason, OrderStatus } from '../domain/order-status.js';
import { EnqueueStaleOrders } from './enqueue-stale-orders.use-case.js';

const MINUTE = 60_000;

const props = (n: number): NewOrderProps => ({
  orderId: `ext-${n}`,
  idempotencyKey: `key-${n}`,
  customer: { email: 'user@example.com', name: 'Ana' },
  items: [{ sku: 'ABC123', qty: 1, unitPrice: 10 }],
  currency: 'USD',
});

describe('EnqueueStaleOrders (orphan sweeper)', () => {
  let now: Date;
  let repository: InMemoryOrderRepository;
  let queue: FakeEnrichmentQueue;

  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const sweeper = (repo: InMemoryOrderRepository = repository) =>
    new EnqueueStaleOrders(
      repo,
      queue,
      { staleAfterMs: 2 * MINUTE, batchSize: 2 },
      () => now,
    );

  /** Stores orders as if received now, optionally walked to another status. */
  async function receive(
    count: number,
    status: OrderStatus = OrderStatus.RECEIVED,
  ) {
    const stored: Order[] = [];
    for (let n = 1; n <= count; n++) {
      const order = Order.receive(props(repository.all().length + 1));
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
      stored.push(await repository.seed(order));
    }
    return stored;
  }

  beforeEach(() => {
    now = new Date('2026-11-10T12:00:00Z');
    repository = new InMemoryOrderRepository(() => now);
    queue = new FakeEnrichmentQueue();
  });

  it('enqueues a RECEIVED order left without a job past the threshold', async () => {
    const [order] = await receive(1);
    advance(3 * MINUTE);

    const result = await sweeper().execute();

    expect(result).toEqual({ enqueued: 1 });
    expect(queue.jobs).toEqual([
      {
        jobId: 'key-1',
        orderId: order!.id,
        requestId: expect.stringMatching(/^sweeper:/),
      },
    ]);
  });

  it('leaves alone a RECEIVED order younger than the threshold', async () => {
    await receive(1);
    advance(1 * MINUTE);

    expect(await sweeper().execute()).toEqual({ enqueued: 0 });
    expect(queue.attempts).toBe(0);
  });

  it.each([
    OrderStatus.ENRICHING,
    OrderStatus.ENRICHED,
    OrderStatus.FAILED_ENRICHMENT,
  ])('ignores an old order that is %s', async (status) => {
    await receive(1, status);
    advance(10 * MINUTE);

    expect(await sweeper().execute()).toEqual({ enqueued: 0 });
  });

  it('sweeps every stale order in one run, batch by batch', async () => {
    await receive(5);
    advance(3 * MINUTE);

    const result = await sweeper().execute();

    expect(result).toEqual({ enqueued: 5 });
    expect(queue.jobs.map((job) => job.jobId).sort()).toEqual([
      'key-1',
      'key-2',
      'key-3',
      'key-4',
      'key-5',
    ]);
  });

  it('does not pick the same orders again on the next run (they may just be waiting in a long queue)', async () => {
    await receive(3);
    advance(3 * MINUTE);
    await sweeper().execute();

    advance(1 * MINUTE);
    const second = await sweeper().execute();

    expect(second).toEqual({ enqueued: 0 });
    expect(queue.attempts).toBe(3);
  });

  it('picks an order again once it stays RECEIVED for another full threshold', async () => {
    const [order] = await receive(1);
    advance(3 * MINUTE);
    await sweeper().execute();

    advance(3 * MINUTE);
    const result = await sweeper().execute();

    expect(result).toEqual({ enqueued: 1 });
    expect(queue.attempts).toBe(2);
    // Same jobId both times: the queue kept a single job.
    expect(queue.jobs).toHaveLength(1);
    expect(repository.queueCheckedAt(order!.id!)).toEqual(now);
  });

  it('stops at the first enqueue failure (Redis is likely down) and leaves the rest for the next run', async () => {
    await receive(3);
    advance(3 * MINUTE);
    queue.failNext(Infinity);

    const failed = await sweeper().execute();

    expect(failed).toEqual({ enqueued: 0, error: expect.any(Error) });
    expect(queue.attempts).toBe(1);

    queue.recover();
    advance(1 * MINUTE);
    expect(await sweeper().execute()).toEqual({ enqueued: 3 });
  });

  it('never loops forever, even if the stamp is not refreshed', async () => {
    // A runaway loop over instantly-resolving fakes would starve the test timeout,
    // so the fake itself fails the test after too many queries.
    class StuckRepository extends InMemoryOrderRepository {
      private queries = 0;
      override async markQueueChecked(): Promise<void> {}
      override async findStaleReceived(cutoff: Date, limit: number) {
        if (++this.queries > 10) throw new Error('sweeper is looping forever');
        return super.findStaleReceived(cutoff, limit);
      }
    }
    repository = new StuckRepository(() => now);
    await receive(3);
    advance(3 * MINUTE);

    const result = await sweeper().execute();

    expect(result).toEqual({ enqueued: 2 });
    expect(queue.attempts).toBe(2);
  });
});
