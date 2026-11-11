import type { Order } from '../domain/order.js';

/**
 * What the API shows of an order: snake_case like the webhook, and nothing
 * personal (customer) nor the idempotency keys (internal, and an abuse vector).
 */
export interface OrderResponse {
  id: string;
  order_id: string;
  status: string;
  currency: string;
  total: number;
  revision: number;
  enrichment: {
    target_currency: string;
    rate: number;
    rate_date: string;
    converted_total: number;
  } | null;
  failure: { reason: string; retryable: boolean } | null;
}

export function presentOrder(order: Order): OrderResponse {
  const { enrichment, failure } = order;
  return {
    id: order.id!,
    order_id: order.orderId,
    status: order.status,
    currency: order.currency,
    total: order.total,
    revision: order.revision,
    enrichment: enrichment && {
      target_currency: enrichment.targetCurrency,
      rate: enrichment.rate,
      rate_date: enrichment.rateDate,
      converted_total: enrichment.convertedTotal,
    },
    failure: failure && {
      reason: failure.reason,
      retryable: failure.retryable,
    },
  };
}
