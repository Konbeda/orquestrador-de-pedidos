import { Types, type Model } from 'mongoose';
import { Order, type OrderSnapshot } from '../../domain/order.js';
import { OrderStatus } from '../../domain/order-status.js';
import {
  ConcurrentUpdateError,
  DuplicateOrderError,
  OrderRepository,
  type OrderListQuery,
  type UniqueField,
} from '../../application/ports/order.repository.js';
import type { OrderDocument } from './order.schema.js';

type StoredFields = Omit<OrderDocument, '_id' | 'created_at' | 'updated_at'>;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export class MongoOrderRepository extends OrderRepository {
  constructor(
    private readonly model: Model<OrderDocument>,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  async findById(id: string): Promise<Order | null> {
    // Mongoose would also accept any 12-char string as an ObjectId; be strict.
    if (!OBJECT_ID.test(id)) return null;
    return this.one({ _id: new Types.ObjectId(id) });
  }

  findByIdempotencyKey(key: string): Promise<Order | null> {
    // Matches any element of the array (multikey index).
    return this.one({ idempotency_keys: key });
  }

  findByOrderId(orderId: string): Promise<Order | null> {
    return this.one({ order_id: orderId });
  }

  async list({
    status,
    orderId,
    limit,
    before,
  }: OrderListQuery): Promise<Order[]> {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (orderId) filter.order_id = orderId;
    if (before) {
      if (!OBJECT_ID.test(before)) return [];
      // ObjectIds grow with creation time: "before this id" = older than it.
      filter._id = { $lt: new Types.ObjectId(before) };
    }
    const documents = await this.model
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .lean<OrderDocument[]>();
    return documents.map((doc) => this.toOrder(doc));
  }

  async insert(order: Order): Promise<Order> {
    try {
      const created = await this.model.create(
        this.toFields(order.toSnapshot()),
      );
      return Order.fromSnapshot({
        ...order.toSnapshot(),
        id: created._id.toHexString(),
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(order: Order, expectedRevision: number): Promise<void> {
    const id = order.id;
    if (!id || !OBJECT_ID.test(id))
      throw new Error(`Order ${id} does not exist`);
    const _id = new Types.ObjectId(id);

    let matched: number;
    try {
      // The revision in the filter is the optimistic lock: matches only if nobody saved since.
      const result = await this.model.updateOne(
        { _id, revision: expectedRevision },
        { $set: this.toFields(order.toSnapshot()) },
      );
      matched = result.matchedCount;
    } catch (error) {
      throw this.translate(error);
    }

    if (matched === 0) {
      if (!(await this.model.exists({ _id })))
        throw new Error(`Order ${id} does not exist`);
      throw new ConcurrentUpdateError(order.orderId);
    }
  }

  async findStaleReceived(cutoff: Date, limit: number): Promise<Order[]> {
    const documents = await this.model
      .find({ status: OrderStatus.RECEIVED, queue_checked_at: { $lt: cutoff } })
      .sort({ queue_checked_at: 1, _id: 1 })
      .limit(limit)
      .lean<OrderDocument[]>();
    return documents.map((doc) => this.toOrder(doc));
  }

  async markQueueChecked(ids: string[], at: Date): Promise<void> {
    const objectIds = ids
      .filter((id) => OBJECT_ID.test(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return;
    await this.model.updateMany(
      { _id: { $in: objectIds }, status: OrderStatus.RECEIVED },
      { $set: { queue_checked_at: at } },
    );
  }

  private async one(filter: Record<string, unknown>): Promise<Order | null> {
    const doc = await this.model.findOne(filter).lean<OrderDocument>();
    return doc ? this.toOrder(doc) : null;
  }

  /** Every write stamps queue_checked_at: a new or changed order starts a fresh sweeper window. */
  private toFields(s: OrderSnapshot): StoredFields {
    return {
      order_id: s.orderId,
      idempotency_keys: s.idempotencyKeys,
      customer: { email: s.customer.email, name: s.customer.name },
      items: s.items.map((i) => ({
        sku: i.sku,
        qty: i.qty,
        unit_price: i.unitPrice,
      })),
      currency: s.currency,
      total: s.total,
      status: s.status,
      enrichment: s.enrichment && {
        target_currency: s.enrichment.targetCurrency,
        rate: s.enrichment.rate,
        rate_date: s.enrichment.rateDate,
        converted_total: s.enrichment.convertedTotal,
      },
      failure: s.failure && {
        reason: s.failure.reason,
        retryable: s.failure.retryable,
      },
      revision: s.revision,
      reprocess_count: s.reprocessCount,
      queue_checked_at: this.now(),
    };
  }

  private toOrder(doc: OrderDocument): Order {
    return Order.fromSnapshot({
      id: doc._id.toHexString(),
      orderId: doc.order_id,
      idempotencyKeys: [...doc.idempotency_keys],
      customer: { email: doc.customer.email, name: doc.customer.name },
      items: doc.items.map((i) => ({
        sku: i.sku,
        qty: i.qty,
        unitPrice: i.unit_price,
      })),
      currency: doc.currency,
      total: doc.total,
      status: doc.status,
      enrichment: doc.enrichment && {
        targetCurrency: doc.enrichment.target_currency,
        rate: doc.enrichment.rate,
        rateDate: doc.enrichment.rate_date,
        convertedTotal: doc.enrichment.converted_total,
      },
      failure: doc.failure && {
        reason: doc.failure.reason,
        retryable: doc.failure.retryable,
      },
      revision: doc.revision,
      reprocessCount: doc.reprocess_count,
    });
  }

  /** E11000 from a unique index → DuplicateOrderError naming which constraint refused. */
  private translate(error: unknown): unknown {
    const mongo = error as {
      code?: number;
      keyPattern?: Record<string, unknown>;
    };
    if (mongo?.code !== 11000) return error;
    const field: UniqueField =
      mongo.keyPattern && 'order_id' in mongo.keyPattern
        ? 'orderId'
        : 'idempotencyKey';
    return new DuplicateOrderError(field);
  }
}
