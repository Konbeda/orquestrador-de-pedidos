import { Order, type NewOrderProps } from '../../src/orders/domain/order.js';
import {
  FailureReason,
  OrderStatus,
} from '../../src/orders/domain/order-status.js';
import {
  ConcurrentUpdateError,
  DuplicateOrderError,
  type OrderRepository,
} from '../../src/orders/application/ports/order.repository.js';

export interface ContractSubject {
  repository: OrderRepository;
  cleanup?: () => Promise<void>;
}

/**
 * Behavior every OrderRepository must have. Runs against the in-memory fake
 * (unit suite) and against MongoDB (integration suite): if both pass, the fake
 * the use case tests rely on tells the truth.
 */
export function describeOrderRepositoryContract(
  label: string,
  setup: (now: () => Date) => Promise<ContractSubject>,
): void {
  describe(`OrderRepository contract: ${label}`, () => {
    let now: Date;
    let subject: ContractSubject;
    let repository: OrderRepository;

    const props = (
      n: number,
      overrides: Partial<NewOrderProps> = {},
    ): NewOrderProps => ({
      orderId: `ext-${n}`,
      idempotencyKey: `key-${n}`,
      customer: { email: `user${n}@example.com`, name: 'Ana' },
      items: [{ sku: 'ABC123', qty: 2, unitPrice: 59.9 }],
      currency: 'USD',
      ...overrides,
    });
    const advance = (ms: number) => {
      now = new Date(now.getTime() + ms);
    };

    beforeEach(async () => {
      now = new Date('2026-11-10T12:00:00.000Z');
      subject = await setup(() => now);
      repository = subject.repository;
    });

    afterEach(async () => {
      await subject.cleanup?.();
    });

    describe('insert and find', () => {
      it('assigns an id and gives back the same order', async () => {
        const order = Order.receive(props(1));
        order.startEnrichment();
        order.completeEnrichment({
          targetCurrency: 'BRL',
          rate: 5.5,
          rateDate: '2026-11-10',
        });

        const stored = await repository.insert(order);

        expect(stored.id).toEqual(expect.any(String));
        const found = await repository.findById(stored.id!);
        expect(found!.toSnapshot()).toEqual({
          ...order.toSnapshot(),
          id: stored.id,
        });
      });

      it('keeps the failure details', async () => {
        const order = Order.receive(props(1, { currency: 'ARS' }));
        order.failEnrichment(FailureReason.UNSUPPORTED_CURRENCY, {
          retryable: false,
        });

        const stored = await repository.insert(order);

        expect((await repository.findById(stored.id!))!.failure).toEqual({
          reason: FailureReason.UNSUPPORTED_CURRENCY,
          retryable: false,
        });
      });

      it.each(['does-not-exist', '000000000000000000000000'])(
        'returns null for an unknown id (%s)',
        async (id) => {
          expect(await repository.findById(id)).toBeNull();
        },
      );

      it('finds by order_id and by any idempotency key the order holds', async () => {
        const stored = await repository.insert(Order.receive(props(1)));
        stored.applyUpdate(props(1, { idempotencyKey: 'key-1b' }), {
          maxRevisions: 10,
        });
        await repository.update(stored, 1);

        expect((await repository.findByOrderId('ext-1'))!.id).toBe(stored.id);
        expect((await repository.findByIdempotencyKey('key-1'))!.id).toBe(
          stored.id,
        );
        expect((await repository.findByIdempotencyKey('key-1b'))!.id).toBe(
          stored.id,
        );
        expect(await repository.findByIdempotencyKey('key-other')).toBeNull();
        expect(await repository.findByOrderId('ext-other')).toBeNull();
      });
    });

    describe('unique constraints', () => {
      it('refuses a second order with the same idempotency key', async () => {
        await repository.insert(Order.receive(props(1)));

        await expect(
          repository.insert(
            Order.receive(props(2, { idempotencyKey: 'key-1' })),
          ),
        ).rejects.toEqual(new DuplicateOrderError('idempotencyKey'));
      });

      it('refuses a key that sits anywhere in another order key list', async () => {
        const first = await repository.insert(Order.receive(props(1)));
        first.applyUpdate(props(1, { idempotencyKey: 'key-1b' }), {
          maxRevisions: 10,
        });
        await repository.update(first, 1);

        await expect(
          repository.insert(
            Order.receive(props(2, { idempotencyKey: 'key-1b' })),
          ),
        ).rejects.toEqual(new DuplicateOrderError('idempotencyKey'));
      });

      it('refuses a second order with the same order_id', async () => {
        await repository.insert(Order.receive(props(1)));

        await expect(
          repository.insert(
            Order.receive(props(1, { idempotencyKey: 'key-other' })),
          ),
        ).rejects.toEqual(new DuplicateOrderError('orderId'));
      });

      it('refuses an update that adds a key another order already holds', async () => {
        await repository.insert(Order.receive(props(1)));
        const second = await repository.insert(Order.receive(props(2)));
        second.applyUpdate(props(2, { idempotencyKey: 'key-1' }), {
          maxRevisions: 10,
        });

        await expect(repository.update(second, 1)).rejects.toEqual(
          new DuplicateOrderError('idempotencyKey'),
        );
      });

      it('lets exactly one of 10 concurrent identical inserts win', async () => {
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, () =>
            repository.insert(Order.receive(props(1))),
          ),
        );

        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(9);
        for (const loss of lost) {
          expect((loss as PromiseRejectedResult).reason).toBeInstanceOf(
            DuplicateOrderError,
          );
        }
      });
    });

    describe('list (GET /orders)', () => {
      /** Stores n orders; the i-th one ends in `statuses[i]` (RECEIVED when absent). */
      async function store(n: number, statuses: OrderStatus[] = []) {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const order = await repository.insert(Order.receive(props(i + 1)));
          if (statuses[i] === OrderStatus.ENRICHING) {
            order.startEnrichment();
            await repository.update(order, 1);
          }
          ids.push(order.id!);
        }
        return ids;
      }
      const idsOf = (orders: Order[]) => orders.map((o) => o.id);

      it('returns the newest first, up to the limit', async () => {
        const [a, b, c] = await store(3);

        expect(idsOf(await repository.list({ limit: 10 }))).toEqual([c, b, a]);
        expect(idsOf(await repository.list({ limit: 2 }))).toEqual([c, b]);
      });

      it('pages with a cursor: orders older than the given id', async () => {
        const [a, b, c] = await store(3);

        expect(idsOf(await repository.list({ limit: 10, before: c }))).toEqual([
          b,
          a,
        ]);
        expect(idsOf(await repository.list({ limit: 10, before: a }))).toEqual(
          [],
        );
      });

      it('filters by status', async () => {
        const [a, b, c] = await store(3, [
          OrderStatus.RECEIVED,
          OrderStatus.ENRICHING,
          OrderStatus.RECEIVED,
        ]);

        expect(
          idsOf(
            await repository.list({ limit: 10, status: OrderStatus.RECEIVED }),
          ),
        ).toEqual([c, a]);
        expect(
          idsOf(
            await repository.list({ limit: 10, status: OrderStatus.ENRICHING }),
          ),
        ).toEqual([b]);
      });

      it('filters by order_id', async () => {
        const [, b] = await store(3);

        expect(
          idsOf(await repository.list({ limit: 10, orderId: 'ext-2' })),
        ).toEqual([b]);
        expect(
          await repository.list({ limit: 10, orderId: 'ext-404' }),
        ).toEqual([]);
      });

      it('combines status, cursor and limit', async () => {
        const [a, , c, d] = await store(4, [
          OrderStatus.RECEIVED,
          OrderStatus.ENRICHING, // b: skipped by the status filter
          OrderStatus.RECEIVED,
          OrderStatus.RECEIVED,
        ]);

        expect(
          idsOf(
            await repository.list({
              limit: 1,
              status: OrderStatus.RECEIVED,
              before: d,
            }),
          ),
        ).toEqual([c]);
        expect(
          idsOf(
            await repository.list({
              limit: 5,
              status: OrderStatus.RECEIVED,
              before: d,
            }),
          ),
        ).toEqual([c, a]);
      });
    });

    describe('findRetryableFailures (reprocess)', () => {
      /** Stores an order that ended FAILED_ENRICHMENT, reprocessed `times` before. */
      async function failed(n: number, { retryable = true, times = 0 } = {}) {
        const order = await repository.insert(Order.receive(props(n)));
        const revision = order.revision;
        for (let run = 0; run <= times; run++) {
          order.startEnrichment();
          order.failEnrichment(FailureReason.PROVIDER_UNAVAILABLE, {
            retryable: run < times ? true : retryable,
          });
          if (run < times) order.requeueForReprocess({ maxReprocessCount: 10 });
        }
        await repository.update(order, revision);
        return order.id!;
      }

      it('returns retryable failures still under the reprocess limit, oldest first', async () => {
        const oldest = await failed(1);
        await failed(2, { retryable: false });
        await failed(3, { times: 3 }); // reached a limit of 3
        const reprocessedOnce = await failed(4, { times: 1 });
        await repository.insert(Order.receive(props(5))); // RECEIVED

        const found = await repository.findRetryableFailures({
          limit: 10,
          maxReprocessCount: 3,
        });

        expect(found.map((o) => o.id)).toEqual([oldest, reprocessedOnce]);
      });

      it('honors the limit', async () => {
        const oldest = await failed(1);
        await failed(2);

        const found = await repository.findRetryableFailures({
          limit: 1,
          maxReprocessCount: 3,
        });

        expect(found.map((o) => o.id)).toEqual([oldest]);
      });
    });

    describe('optimistic lock on revision', () => {
      it('saves when the stored revision is the expected one', async () => {
        const order = await repository.insert(Order.receive(props(1)));
        order.startEnrichment();

        await repository.update(order, 1);

        expect((await repository.findById(order.id!))!.status).toBe(
          OrderStatus.ENRICHING,
        );
      });

      it('refuses a save based on an old revision and keeps the stored order', async () => {
        const order = await repository.insert(Order.receive(props(1)));
        const staleCopy = (await repository.findById(order.id!))!;
        order.applyUpdate(props(1, { idempotencyKey: 'key-1b' }), {
          maxRevisions: 10,
        });
        await repository.update(order, 1); // stored revision is now 2

        staleCopy.startEnrichment();

        await expect(repository.update(staleCopy, 1)).rejects.toBeInstanceOf(
          ConcurrentUpdateError,
        );
        expect((await repository.findById(order.id!))!.revision).toBe(2);
        expect((await repository.findById(order.id!))!.status).toBe(
          OrderStatus.RECEIVED,
        );
      });
    });

    describe('orphan sweeper support (queue_checked_at)', () => {
      const MINUTE = 60_000;

      it('finds RECEIVED orders unchecked since the cutoff, oldest first, up to the limit', async () => {
        const a = await repository.insert(Order.receive(props(1))); // t0
        advance(MINUTE);
        const b = await repository.insert(Order.receive(props(2))); // t0 + 1 min
        advance(10 * MINUTE);
        await repository.insert(Order.receive(props(3))); // t0 + 11 min
        const cutoff = new Date(now.getTime() - 5 * MINUTE); // t0 + 6 min: a and b are older

        const stale = await repository.findStaleReceived(cutoff, 10);

        expect(stale.map((o) => o.id)).toEqual([a.id, b.id]);
        expect(
          (await repository.findStaleReceived(cutoff, 1)).map((o) => o.id),
        ).toEqual([a.id]);
      });

      it('orders by last queue check, not by insertion', async () => {
        const first = await repository.insert(Order.receive(props(1)));
        const second = await repository.insert(Order.receive(props(2)));
        advance(MINUTE);
        await repository.markQueueChecked([first.id!], now); // first is now the most recent
        advance(10 * MINUTE);

        const stale = await repository.findStaleReceived(now, 10);

        expect(stale.map((o) => o.id)).toEqual([second.id, first.id]);
      });

      it('ignores orders that left RECEIVED', async () => {
        const order = await repository.insert(Order.receive(props(1)));
        order.startEnrichment();
        await repository.update(order, 1);
        advance(10 * MINUTE);

        expect(await repository.findStaleReceived(now, 10)).toEqual([]);
      });

      it('an update stamps the order again', async () => {
        const order = await repository.insert(Order.receive(props(1)));
        advance(10 * MINUTE);
        order.applyUpdate(props(1, { idempotencyKey: 'key-1b' }), {
          maxRevisions: 10,
        });
        await repository.update(order, 1);

        expect(
          await repository.findStaleReceived(new Date(now.getTime() - 1), 10),
        ).toEqual([]);
      });

      it('markQueueChecked moves RECEIVED orders out of the stale window', async () => {
        const order = await repository.insert(Order.receive(props(1)));
        advance(10 * MINUTE);

        await repository.markQueueChecked([order.id!], now);

        expect(
          await repository.findStaleReceived(new Date(now.getTime() - 1), 10),
        ).toEqual([]);
        expect(
          await repository.findStaleReceived(new Date(now.getTime() + 1), 10),
        ).toHaveLength(1);
      });
    });
  });
}
