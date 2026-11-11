import { Schema, type Types } from 'mongoose';
import { FailureReason, OrderStatus } from '../../domain/order-status.js';

export const ORDER_MODEL = 'Order';

/** Stored shape: snake_case, like the webhook payload and the API responses. */
export interface OrderDocument {
  _id: Types.ObjectId;
  order_id: string;
  idempotency_keys: string[];
  customer: { email: string; name: string };
  items: Array<{ sku: string; qty: number; unit_price: number }>;
  currency: string;
  total: number;
  status: OrderStatus;
  enrichment: {
    target_currency: string;
    rate: number;
    rate_date: string;
    converted_total: number;
  } | null;
  failure: { reason: FailureReason; retryable: boolean } | null;
  revision: number;
  reprocess_count: number;
  /** Persistence metadata for the orphan sweeper; not part of the domain. */
  queue_checked_at: Date;
  created_at: Date;
  updated_at: Date;
}

const noId = { _id: false } as const;

export const OrderSchema = new Schema<OrderDocument>(
  {
    order_id: { type: String, required: true },
    idempotency_keys: { type: [String], required: true },
    customer: {
      type: new Schema({ email: String, name: String }, noId),
      required: true,
    },
    items: {
      type: [
        new Schema({ sku: String, qty: Number, unit_price: Number }, noId),
      ],
      required: true,
    },
    currency: { type: String, required: true },
    total: { type: Number, required: true },
    status: { type: String, enum: Object.values(OrderStatus), required: true },
    enrichment: {
      type: new Schema(
        {
          target_currency: String,
          rate: Number,
          rate_date: String,
          converted_total: Number,
        },
        noId,
      ),
      default: null,
    },
    failure: {
      type: new Schema(
        {
          reason: { type: String, enum: Object.values(FailureReason) },
          retryable: Boolean,
        },
        noId,
      ),
      default: null,
    },
    revision: { type: Number, required: true },
    reprocess_count: { type: Number, required: true },
    queue_checked_at: { type: Date, required: true },
  },
  {
    collection: 'orders',
    versionKey: false, // concurrency is handled by `revision`, not Mongoose's __v
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  },
);

// Idempotency (source of truth). Unique on an array (multikey): no key may appear in
// two orders; an order can hold several keys (update policy).
OrderSchema.index({ idempotency_keys: 1 }, { unique: true });
OrderSchema.index({ order_id: 1 }, { unique: true });
// Orphan sweeper: RECEIVED orders by last queue check.
OrderSchema.index({ status: 1, queue_checked_at: 1 });
// GET /orders?status= newest first, with the cursor (_id < before) in the same index scan.
OrderSchema.index({ status: 1, _id: -1 });
// Reprocess scan (retryable failures).
OrderSchema.index({ status: 1, 'failure.retryable': 1, created_at: -1 });
