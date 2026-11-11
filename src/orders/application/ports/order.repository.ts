import type { Order } from '../../domain/order.js';

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

/**
 * Persistence port. Implementations must enforce unique idempotency keys
 * (across all orders) and unique order ids, raising DuplicateOrderError.
 */
export abstract class OrderRepository {
  abstract findByIdempotencyKey(key: string): Promise<Order | null>;
  abstract findByOrderId(orderId: string): Promise<Order | null>;
  /** Stores a new order and returns it with its generated id. */
  abstract insert(order: Order): Promise<Order>;
  /** Saves only if the stored revision still equals `expectedRevision`, else ConcurrentUpdateError. */
  abstract update(order: Order, expectedRevision: number): Promise<void>;
}
