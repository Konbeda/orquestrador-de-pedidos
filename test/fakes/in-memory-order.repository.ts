import { Order, type OrderSnapshot } from '../../src/orders/domain/order.js';
import { OrderStatus } from '../../src/orders/domain/order-status.js';
import {
  ConcurrentUpdateError,
  DuplicateOrderError,
  OrderRepository,
  type OrderListQuery,
} from '../../src/orders/application/ports/order.repository.js';

interface Row {
  snapshot: OrderSnapshot;
  queueCheckedAt: Date;
}

/**
 * Behaves like the Mongo repository: unique keys across orders, unique order ids,
 * optimistic lock on revision, queueCheckedAt stamped on every write.
 * Stores snapshots so callers never share mutable state.
 */
export class InMemoryOrderRepository extends OrderRepository {
  private readonly rows = new Map<string, Row>();
  private nextId = 1;
  private pendingConcurrentInsert: Order | null = null;
  private pendingConcurrentUpdate = false;
  private insertAfterNextKeyLookup: Order | null = null;
  /** One entry per upcoming update call: an Error fails that call, null lets it through. */
  private plannedUpdateFailures: Array<Error | null> = [];

  /** `now` is the clock used to stamp writes; tests move it to age orders. */
  constructor(private readonly now: () => Date = () => new Date()) {
    super();
  }

  async findById(id: string): Promise<Order | null> {
    const row = this.rows.get(id);
    return row ? Order.fromSnapshot(row.snapshot) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    const found = this.findOne((s) => s.idempotencyKeys.includes(key));
    if (this.insertAfterNextKeyLookup) {
      const winner = this.insertAfterNextKeyLookup;
      this.insertAfterNextKeyLookup = null;
      await this.insert(winner);
    }
    return found;
  }

  async findByOrderId(orderId: string): Promise<Order | null> {
    return this.findOne((s) => s.orderId === orderId);
  }

  async list({
    status,
    orderId,
    limit,
    before,
  }: OrderListQuery): Promise<Order[]> {
    // Ids are `order_<sequence>`: the sequence plays the role of the ObjectId time order.
    const seq = (id: string) => Number(id.slice('order_'.length));
    return this.snapshots()
      .filter((s) => !status || s.status === status)
      .filter((s) => !orderId || s.orderId === orderId)
      .filter((s) => !before || seq(s.id!) < seq(before))
      .sort((a, b) => seq(b.id!) - seq(a.id!))
      .slice(0, limit)
      .map((s) => Order.fromSnapshot(s));
  }

  async insert(order: Order): Promise<Order> {
    if (this.pendingConcurrentInsert) {
      const winner = this.pendingConcurrentInsert;
      this.pendingConcurrentInsert = null;
      await this.insert(winner);
    }
    const snapshot = order.toSnapshot();
    const stored = this.snapshots();
    if (
      stored.some((s) =>
        s.idempotencyKeys.some((k) => snapshot.idempotencyKeys.includes(k)),
      )
    ) {
      throw new DuplicateOrderError('idempotencyKey');
    }
    if (stored.some((s) => s.orderId === snapshot.orderId)) {
      throw new DuplicateOrderError('orderId');
    }
    const id = `order_${this.nextId++}`;
    this.rows.set(id, {
      snapshot: { ...snapshot, id },
      queueCheckedAt: this.now(),
    });
    return Order.fromSnapshot({ ...snapshot, id });
  }

  async update(order: Order, expectedRevision: number): Promise<void> {
    const plannedFailure = this.plannedUpdateFailures.shift();
    if (plannedFailure) throw plannedFailure;
    const row = order.id ? this.rows.get(order.id) : undefined;
    if (!row) throw new Error(`Order ${order.id} does not exist`);
    if (
      this.pendingConcurrentUpdate ||
      row.snapshot.revision !== expectedRevision
    ) {
      this.pendingConcurrentUpdate = false;
      throw new ConcurrentUpdateError(order.orderId);
    }
    // Same unique index as on insert: no key may sit in two orders.
    const keys = order.idempotencyKeys;
    const takenElsewhere = [...this.rows.entries()].some(
      ([id, other]) =>
        id !== order.id &&
        other.snapshot.idempotencyKeys.some((k) => keys.includes(k)),
    );
    if (takenElsewhere) throw new DuplicateOrderError('idempotencyKey');
    this.rows.set(order.id!, {
      snapshot: { ...order.toSnapshot(), id: order.id },
      queueCheckedAt: this.now(),
    });
  }

  async findStaleReceived(cutoff: Date, limit: number): Promise<Order[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.snapshot.status === OrderStatus.RECEIVED &&
          row.queueCheckedAt.getTime() < cutoff.getTime(),
      )
      .sort((a, b) => a.queueCheckedAt.getTime() - b.queueCheckedAt.getTime())
      .slice(0, limit)
      .map((row) => Order.fromSnapshot(row.snapshot));
  }

  async markQueueChecked(ids: string[], at: Date): Promise<void> {
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row?.snapshot.status === OrderStatus.RECEIVED)
        row.queueCheckedAt = at;
    }
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

  /**
   * Database hiccups on chosen update calls, e.g. `[null, error]` lets the next
   * update through and fails the one after it.
   */
  planUpdateFailures(plan: Array<Error | null>): void {
    this.plannedUpdateFailures = [...plan];
  }

  /**
   * Race simulation: `winner` is stored right after the next lookup by key answers,
   * so the following lookup by order_id already sees it.
   */
  simulateInsertBetweenLookups(winner: Order): void {
    this.insertAfterNextKeyLookup = winner;
  }

  /** Race simulation: the next update finds a newer revision stored. */
  simulateConcurrentUpdate(): void {
    this.pendingConcurrentUpdate = true;
  }

  /** Changes a stored order behind the use case's back (e.g. a worker picking it up). */
  async mutate(id: string, change: (order: Order) => void): Promise<void> {
    const row = this.rows.get(id)!;
    const order = Order.fromSnapshot(row.snapshot);
    change(order);
    row.snapshot = order.toSnapshot();
  }

  queueCheckedAt(id: string): Date | undefined {
    return this.rows.get(id)?.queueCheckedAt;
  }

  all(): Order[] {
    return this.snapshots().map((s) => Order.fromSnapshot(s));
  }

  private snapshots(): OrderSnapshot[] {
    return [...this.rows.values()].map((row) => row.snapshot);
  }

  private findOne(match: (s: OrderSnapshot) => boolean): Order | null {
    const snapshot = this.snapshots().find(match);
    return snapshot ? Order.fromSnapshot(snapshot) : null;
  }
}
