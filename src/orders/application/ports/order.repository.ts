import type { Order } from '../../domain/order.js';
import type { OrderStatus } from '../../domain/order-status.js';

/** Which unique index rejected a write. */
export type UniqueField = 'idempotencyKey' | 'orderId';

/** A unique index refused the insert: another request stored the same key or order_id first. */
export class DuplicateOrderError extends Error {
  override name = 'DuplicateOrderError';
  constructor(readonly field: UniqueField) {
    super(`An order with the same ${field} already exists`);
  }
}

/** Optimistic lock: the order changed (another revision was saved) since it was read. */
export class ConcurrentUpdateError extends Error {
  override name = 'ConcurrentUpdateError';
  constructor(readonly orderId: string) {
    super(`Order ${orderId} was modified concurrently; retry the request`);
  }
}

export interface OrderListQuery {
  status?: OrderStatus;
  /** External order id (exact match). */
  orderId?: string;
  limit: number;
  /** Cursor: only orders created before the one with this id. */
  before?: string;
}

/**
 * Persistence port. Implementations must enforce unique idempotency keys
 * (across all orders) and unique order ids, raising DuplicateOrderError.
 */
export abstract class OrderRepository {
  /** By internal (database) id, the one carried by queue jobs. */
  abstract findById(id: string): Promise<Order | null>;
  abstract findByIdempotencyKey(key: string): Promise<Order | null>;
  abstract findByOrderId(orderId: string): Promise<Order | null>;
  /** Newest first. */
  abstract list(query: OrderListQuery): Promise<Order[]>;
  /**
   * FAILED_ENRICHMENT, retryable, reprocessed fewer than `maxReprocessCount` times,
   * oldest first. The limit is in the query so exhausted orders never fill a batch.
   */
  abstract findRetryableFailures(query: {
    limit: number;
    maxReprocessCount: number;
  }): Promise<Order[]>;
  /** Stores a new order and returns it with its generated id. */
  abstract insert(order: Order): Promise<Order>;
  /** Saves only if the stored revision still equals `expectedRevision`, else ConcurrentUpdateError. */
  abstract update(order: Order, expectedRevision: number): Promise<void>;

  /*
   * Orphan sweeper support. Every stored order carries a persistence-level
   * `queueCheckedAt` timestamp: set on insert and update, refreshed by the sweeper
   * after it enqueues. Staleness is measured from it, not from creation, so an
   * order already waiting in a long queue is not picked again on every run.
   */

  /** RECEIVED orders whose `queueCheckedAt` is older than `cutoff`, oldest first. */
  abstract findStaleReceived(cutoff: Date, limit: number): Promise<Order[]>;

  /** Refreshes `queueCheckedAt` of the given orders that are still RECEIVED. */
  abstract markQueueChecked(ids: string[], at: Date): Promise<void>;
}
