import { Order, type OrderSnapshot } from '../../src/orders/domain/order.js';
import {
  ConcurrentUpdateError,
  DuplicateOrderError,
  OrderRepository,
} from '../../src/orders/application/ports/order.repository.js';

/**
 * Behaves like the Mongo repository: unique keys across orders, unique order ids,
 * optimistic lock on revision. Stores snapshots so callers never share mutable state.
 */
export class InMemoryOrderRepository extends OrderRepository {
  private readonly rows = new Map<string, OrderSnapshot>();
  private nextId = 1;
  private pendingConcurrentInsert: Order | null = null;
  private pendingConcurrentUpdate = false;

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    const row = [...this.rows.values()].find((r) =>
      r.idempotencyKeys.includes(key),
    );
    return row ? Order.fromSnapshot(row) : null;
  }

  async findByOrderId(orderId: string): Promise<Order | null> {
    const row = [...this.rows.values()].find((r) => r.orderId === orderId);
    return row ? Order.fromSnapshot(row) : null;
  }

  async insert(order: Order): Promise<Order> {
    if (this.pendingConcurrentInsert) {
      const winner = this.pendingConcurrentInsert;
      this.pendingConcurrentInsert = null;
      await this.insert(winner);
    }
    const snapshot = order.toSnapshot();
    const rows = [...this.rows.values()];
    if (
      rows.some((r) =>
        r.idempotencyKeys.some((k) => snapshot.idempotencyKeys.includes(k)),
      )
    ) {
      throw new DuplicateOrderError('idempotencyKey');
    }
    if (rows.some((r) => r.orderId === snapshot.orderId)) {
      throw new DuplicateOrderError('orderId');
    }
    const id = `order_${this.nextId++}`;
    this.rows.set(id, { ...snapshot, id });
    return Order.fromSnapshot({ ...snapshot, id });
  }

  async update(order: Order, expectedRevision: number): Promise<void> {
    const stored = order.id ? this.rows.get(order.id) : undefined;
    if (!stored) throw new Error(`Order ${order.id} does not exist`);
    if (this.pendingConcurrentUpdate || stored.revision !== expectedRevision) {
      this.pendingConcurrentUpdate = false;
      throw new ConcurrentUpdateError(order.orderId);
    }
    this.rows.set(stored.id!, { ...order.toSnapshot(), id: stored.id });
  }

  // ---- test controls -------------------------------------------------------

  /** Seeds an order as if it had been received earlier. */
  async seed(order: Order): Promise<Order> {
    return this.insert(order);
  }

  /**
   * Race simulation: right before the next insert, `winner` is stored as if a
   * concurrent request got there first (after our lookups found nothing).
   */
  simulateConcurrentInsert(winner: Order): void {
    this.pendingConcurrentInsert = winner;
  }

  /** Race simulation: the next update finds a newer revision stored. */
  simulateConcurrentUpdate(): void {
    this.pendingConcurrentUpdate = true;
  }

  all(): Order[] {
    return [...this.rows.values()].map((row) => Order.fromSnapshot(row));
  }
}
