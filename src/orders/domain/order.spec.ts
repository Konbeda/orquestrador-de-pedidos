import {
  InvalidOrderError,
  InvalidOrderTransitionError,
  Order,
  OrderBeingProcessedError,
  ReprocessNotAllowedError,
  type NewOrderProps,
} from './order.js';
import { FailureReason, OrderStatus } from './order-status.js';

const newOrder = (overrides: Partial<NewOrderProps> = {}): NewOrderProps => ({
  orderId: 'ext-123',
  idempotencyKey: 'key-1',
  customer: { email: 'user@example.com', name: 'Ana' },
  items: [{ sku: 'ABC123', qty: 2, unitPrice: 59.9 }],
  currency: 'USD',
  ...overrides,
});

const enrichment = { targetCurrency: 'BRL', rate: 5.5, rateDate: '2026-11-10' };

/** Walks an order to a given status through the public API only. */
function orderIn(status: OrderStatus): Order {
  const order = Order.receive(newOrder());
  if (status === OrderStatus.RECEIVED) return order;
  order.startEnrichment();
  if (status === OrderStatus.ENRICHING) return order;
  if (status === OrderStatus.ENRICHED) {
    order.completeEnrichment(enrichment);
    return order;
  }
  order.failEnrichment(FailureReason.PROVIDER_UNAVAILABLE, { retryable: true });
  return order;
}

describe('Order', () => {
  describe('receive', () => {
    it('starts as RECEIVED, on revision 1, remembering its idempotency key', () => {
      const order = Order.receive(newOrder());

      expect(order.status).toBe(OrderStatus.RECEIVED);
      expect(order.revision).toBe(1);
      expect(order.idempotencyKeys).toEqual(['key-1']);
      expect(order.failure).toBeNull();
      expect(order.enrichment).toBeNull();
    });

    it('normalizes the currency to uppercase', () => {
      expect(Order.receive(newOrder({ currency: 'usd' })).currency).toBe('USD');
    });

    it('computes the total from the items without floating point drift', () => {
      const order = Order.receive(
        newOrder({
          items: [
            { sku: 'A', qty: 3, unitPrice: 0.1 },
            { sku: 'B', qty: 2, unitPrice: 59.9 },
          ],
        }),
      );

      // 0.1 * 3 in floating point is 0.30000000000000004
      expect(order.total).toBe(120.1);
    });

    it.each([
      ['no items', { items: [] }],
      [
        'a non positive quantity',
        { items: [{ sku: 'A', qty: 0, unitPrice: 1 }] },
      ],
      [
        'a fractional quantity',
        { items: [{ sku: 'A', qty: 1.5, unitPrice: 1 }] },
      ],
      ['a negative price', { items: [{ sku: 'A', qty: 1, unitPrice: -1 }] }],
      ['an empty idempotency key', { idempotencyKey: '' }],
      ['an empty order id', { orderId: ' ' }],
    ])('refuses an order with %s', (_case, overrides) => {
      expect(() =>
        Order.receive(newOrder(overrides as Partial<NewOrderProps>)),
      ).toThrow(InvalidOrderError);
    });
  });

  describe('enrichment lifecycle', () => {
    it('goes RECEIVED → ENRICHING → ENRICHED, storing the converted total', () => {
      const order = Order.receive(newOrder());

      order.startEnrichment();
      expect(order.status).toBe(OrderStatus.ENRICHING);

      order.completeEnrichment(enrichment);
      expect(order.status).toBe(OrderStatus.ENRICHED);
      expect(order.enrichment).toEqual({
        targetCurrency: 'BRL',
        rate: 5.5,
        rateDate: '2026-11-10',
        convertedTotal: 658.9, // 119.8 * 5.5
      });
    });

    it('lets a retried job start enrichment again while still ENRICHING', () => {
      const order = orderIn(OrderStatus.ENRICHING);

      expect(() => order.startEnrichment()).not.toThrow();
      expect(order.status).toBe(OrderStatus.ENRICHING);
    });

    it('cannot complete an enrichment that never started', () => {
      expect(() =>
        orderIn(OrderStatus.RECEIVED).completeEnrichment(enrichment),
      ).toThrow(InvalidOrderTransitionError);
    });

    it.each([OrderStatus.ENRICHED, OrderStatus.FAILED_ENRICHMENT])(
      'cannot start enrichment from %s',
      (status) => {
        expect(() => orderIn(status).startEnrichment()).toThrow(
          InvalidOrderTransitionError,
        );
      },
    );

    it('only needs enrichment while RECEIVED or ENRICHING (worker idempotency)', () => {
      expect(orderIn(OrderStatus.RECEIVED).needsEnrichment).toBe(true);
      expect(orderIn(OrderStatus.ENRICHING).needsEnrichment).toBe(true);
      expect(orderIn(OrderStatus.ENRICHED).needsEnrichment).toBe(false);
      expect(orderIn(OrderStatus.FAILED_ENRICHMENT).needsEnrichment).toBe(
        false,
      );
    });
  });

  describe('failEnrichment', () => {
    it('records the reason and whether it can be reprocessed', () => {
      const order = orderIn(OrderStatus.ENRICHING);

      order.failEnrichment(FailureReason.PROVIDER_UNAVAILABLE, {
        retryable: true,
      });

      expect(order.status).toBe(OrderStatus.FAILED_ENRICHMENT);
      expect(order.failure).toEqual({
        reason: FailureReason.PROVIDER_UNAVAILABLE,
        retryable: true,
      });
    });

    it('can fail straight from RECEIVED, for an unsupported currency caught at intake', () => {
      const order = orderIn(OrderStatus.RECEIVED);

      order.failEnrichment(FailureReason.UNSUPPORTED_CURRENCY, {
        retryable: false,
      });

      expect(order.status).toBe(OrderStatus.FAILED_ENRICHMENT);
      expect(order.failure?.reason).toBe(FailureReason.UNSUPPORTED_CURRENCY);
    });

    it('cannot fail an order that is already ENRICHED', () => {
      expect(() =>
        orderIn(OrderStatus.ENRICHED).failEnrichment(
          FailureReason.PROVIDER_REJECTED,
          {
            retryable: false,
          },
        ),
      ).toThrow(InvalidOrderTransitionError);
    });
  });

  describe('requeueForReprocess', () => {
    it('sends a retryable failure back to RECEIVED and counts the attempt', () => {
      const order = orderIn(OrderStatus.FAILED_ENRICHMENT);

      order.requeueForReprocess({ maxReprocessCount: 3 });

      expect(order.status).toBe(OrderStatus.RECEIVED);
      expect(order.reprocessCount).toBe(1);
      expect(order.failure).toBeNull();
    });

    it('refuses a failure that is not retryable', () => {
      const order = orderIn(OrderStatus.ENRICHING);
      order.failEnrichment(FailureReason.PROVIDER_REJECTED, {
        retryable: false,
      });

      expect(() => order.requeueForReprocess({ maxReprocessCount: 3 })).toThrow(
        ReprocessNotAllowedError,
      );
    });

    it('refuses once the reprocess limit is reached, so a bad order cannot loop forever', () => {
      const order = orderIn(OrderStatus.FAILED_ENRICHMENT);
      order.requeueForReprocess({ maxReprocessCount: 1 });
      order.startEnrichment();
      order.failEnrichment(FailureReason.PROVIDER_UNAVAILABLE, {
        retryable: true,
      });

      expect(() => order.requeueForReprocess({ maxReprocessCount: 1 })).toThrow(
        ReprocessNotAllowedError,
      );
    });

    it.each([
      OrderStatus.RECEIVED,
      OrderStatus.ENRICHING,
      OrderStatus.ENRICHED,
    ])('refuses an order in %s', (status) => {
      expect(() =>
        orderIn(status).requeueForReprocess({ maxReprocessCount: 3 }),
      ).toThrow(ReprocessNotAllowedError);
    });
  });

  describe('applyUpdate (ORDER_DUPLICATE_POLICY=update)', () => {
    const changes = newOrder({
      idempotencyKey: 'key-2',
      items: [{ sku: 'ABC123', qty: 5, unitPrice: 10 }],
    });

    it('updates a RECEIVED order in place: the queued job will read the new version', () => {
      const order = orderIn(OrderStatus.RECEIVED);

      const { requiresEnqueue } = order.applyUpdate(changes);

      expect(requiresEnqueue).toBe(false);
      expect(order.status).toBe(OrderStatus.RECEIVED);
      expect(order.total).toBe(50);
      expect(order.revision).toBe(2);
      expect(order.idempotencyKeys).toEqual(['key-1', 'key-2']);
    });

    it('refuses while ENRICHING, to avoid racing the worker', () => {
      expect(() => orderIn(OrderStatus.ENRICHING).applyUpdate(changes)).toThrow(
        OrderBeingProcessedError,
      );
    });

    it.each([OrderStatus.ENRICHED, OrderStatus.FAILED_ENRICHMENT])(
      'resets a %s order to RECEIVED and asks for a new job',
      (status) => {
        const order = orderIn(status);

        const { requiresEnqueue } = order.applyUpdate(changes);

        expect(requiresEnqueue).toBe(true);
        expect(order.status).toBe(OrderStatus.RECEIVED);
        expect(order.enrichment).toBeNull();
        expect(order.failure).toBeNull();
        expect(order.total).toBe(50);
        expect(order.revision).toBe(2);
      },
    );

    it('refuses changes that belong to another order', () => {
      expect(() =>
        orderIn(OrderStatus.RECEIVED).applyUpdate({
          ...changes,
          orderId: 'ext-999',
        }),
      ).toThrow(InvalidOrderError);
    });
  });

  describe('snapshot', () => {
    it('round-trips through persistence without losing state', () => {
      const original = orderIn(OrderStatus.ENRICHED);

      const restored = Order.fromSnapshot({
        ...original.toSnapshot(),
        id: 'abc',
      });

      expect(restored.toSnapshot()).toEqual({
        ...original.toSnapshot(),
        id: 'abc',
      });
      expect(restored.id).toBe('abc');
    });
  });
});
