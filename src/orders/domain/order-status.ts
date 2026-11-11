export const OrderStatus = {
  RECEIVED: 'RECEIVED',
  ENRICHING: 'ENRICHING',
  ENRICHED: 'ENRICHED',
  FAILED_ENRICHMENT: 'FAILED_ENRICHMENT',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Why an order ended in FAILED_ENRICHMENT. The status stays one; the reason tells them apart. */
export const FailureReason = {
  /** Valid ISO 4217 code that the exchange provider does not convert. Caught at intake. */
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  /** Provider down, timing out or answering 5xx until the attempts ran out. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** Provider answered 4xx: retrying the same request cannot succeed. */
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
} as const;
export type FailureReason = (typeof FailureReason)[keyof typeof FailureReason];
