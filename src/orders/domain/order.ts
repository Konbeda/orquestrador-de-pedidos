import { fromCents, toCents } from './money.js';
import { FailureReason, OrderStatus } from './order-status.js';

export interface Customer {
  email: string;
  name: string;
}

export interface OrderItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface NewOrderProps {
  orderId: string;
  idempotencyKey: string;
  customer: Customer;
  items: OrderItem[];
  currency: string;
}

export interface Enrichment {
  targetCurrency: string;
  rate: number;
  /** Date of the exchange rate used, as reported by the provider. */
  rateDate: string;
  convertedTotal: number;
}

export interface Failure {
  reason: FailureReason;
  retryable: boolean;
}

export interface OrderSnapshot {
  id?: string;
  orderId: string;
  /** Every key applied to this order; the last one is the current operation. */
  idempotencyKeys: string[];
  customer: Customer;
  items: OrderItem[];
  currency: string;
  total: number;
  status: OrderStatus;
  enrichment: Enrichment | null;
  failure: Failure | null;
  revision: number;
  reprocessCount: number;
}

export class InvalidOrderError extends Error {
  override name = 'InvalidOrderError';
}

export class InvalidOrderTransitionError extends Error {
  override name = 'InvalidOrderTransitionError';
  constructor(
    readonly from: OrderStatus,
    readonly action: string,
  ) {
    super(`Cannot ${action} an order in status ${from}`);
  }
}

export class OrderBeingProcessedError extends Error {
  override name = 'OrderBeingProcessedError';
  constructor(readonly orderId: string) {
    super(`Order ${orderId} is being enriched right now; try again later`);
  }
}

export class ReprocessNotAllowedError extends Error {
  override name = 'ReprocessNotAllowedError';
}

/**
 * The order aggregate: owns its status machine and money rules.
 * Knows nothing about HTTP, Mongo or BullMQ.
 *
 *   RECEIVED → ENRICHING → ENRICHED
 *       ↘          ↘
 *        FAILED_ENRICHMENT (failure.reason, failure.retryable)
 */
export class Order {
  private constructor(private state: OrderSnapshot) {}

  static receive(props: NewOrderProps): Order {
    const data = Order.validated(props);
    return new Order({
      orderId: data.orderId,
      idempotencyKeys: [data.idempotencyKey],
      customer: { ...data.customer },
      items: data.items.map((item) => ({ ...item })),
      currency: data.currency,
      total: Order.totalOf(data.items),
      status: OrderStatus.RECEIVED,
      enrichment: null,
      failure: null,
      revision: 1,
      reprocessCount: 0,
    });
  }

  static fromSnapshot(snapshot: OrderSnapshot): Order {
    return new Order(structuredClone(snapshot));
  }

  toSnapshot(): OrderSnapshot {
    return structuredClone(this.state);
  }

  get id(): string | undefined {
    return this.state.id;
  }
  get orderId(): string {
    return this.state.orderId;
  }
  get idempotencyKeys(): readonly string[] {
    return this.state.idempotencyKeys;
  }
  /** Key of the latest operation applied; used as the queue jobId. */
  get currentIdempotencyKey(): string {
    return this.state.idempotencyKeys.at(-1)!;
  }
  get currency(): string {
    return this.state.currency;
  }
  get total(): number {
    return this.state.total;
  }
  get status(): OrderStatus {
    return this.state.status;
  }
  get enrichment(): Enrichment | null {
    return this.state.enrichment;
  }
  get failure(): Failure | null {
    return this.state.failure;
  }
  get revision(): number {
    return this.state.revision;
  }
  get reprocessCount(): number {
    return this.state.reprocessCount;
  }

  /** False once the order reached a final state: a redelivered job must do nothing. */
  get needsEnrichment(): boolean {
    return (
      this.status === OrderStatus.RECEIVED ||
      this.status === OrderStatus.ENRICHING
    );
  }

  /** Allowed again while ENRICHING: a retried job resumes the same enrichment. */
  startEnrichment(): void {
    this.assertStatus(['RECEIVED', 'ENRICHING'], 'start enrichment of');
    this.state.status = OrderStatus.ENRICHING;
  }

  completeEnrichment(result: Omit<Enrichment, 'convertedTotal'>): void {
    this.assertStatus(['ENRICHING'], 'complete enrichment of');
    this.state.enrichment = {
      ...result,
      convertedTotal: fromCents(Math.round(toCents(this.total) * result.rate)),
    };
    this.state.failure = null;
    this.state.status = OrderStatus.ENRICHED;
  }

  /** From RECEIVED too: an unsupported currency is caught at intake, before any job. */
  failEnrichment(
    reason: FailureReason,
    { retryable }: { retryable: boolean },
  ): void {
    this.assertStatus(['RECEIVED', 'ENRICHING'], 'fail enrichment of');
    this.state.failure = { reason, retryable };
    this.state.status = OrderStatus.FAILED_ENRICHMENT;
  }

  requeueForReprocess({
    maxReprocessCount,
  }: {
    maxReprocessCount: number;
  }): void {
    if (this.status !== OrderStatus.FAILED_ENRICHMENT) {
      throw new ReprocessNotAllowedError(
        `Order ${this.orderId} is ${this.status}, not FAILED_ENRICHMENT`,
      );
    }
    if (!this.failure?.retryable) {
      throw new ReprocessNotAllowedError(
        `Order ${this.orderId} failed with a non retryable reason`,
      );
    }
    if (this.reprocessCount >= maxReprocessCount) {
      throw new ReprocessNotAllowedError(
        `Order ${this.orderId} reached the reprocess limit (${maxReprocessCount})`,
      );
    }
    this.state.reprocessCount += 1;
    this.state.failure = null;
    this.state.status = OrderStatus.RECEIVED;
  }

  /**
   * Same order_id arriving with a new idempotency key, under ORDER_DUPLICATE_POLICY=update.
   * `requiresEnqueue` tells the caller whether a new enrichment job is needed.
   */
  applyUpdate(changes: NewOrderProps): { requiresEnqueue: boolean } {
    const data = Order.validated(changes);
    if (data.orderId !== this.orderId) {
      throw new InvalidOrderError(
        `Update for ${data.orderId} cannot be applied to ${this.orderId}`,
      );
    }
    if (this.status === OrderStatus.ENRICHING) {
      throw new OrderBeingProcessedError(this.orderId);
    }

    const requiresEnqueue = this.status !== OrderStatus.RECEIVED;
    Object.assign(this.state, {
      idempotencyKeys: [...this.state.idempotencyKeys, data.idempotencyKey],
      customer: { ...data.customer },
      items: data.items.map((item) => ({ ...item })),
      currency: data.currency,
      total: Order.totalOf(data.items),
      status: OrderStatus.RECEIVED,
      enrichment: null,
      failure: null,
      revision: this.revision + 1,
    });
    return { requiresEnqueue };
  }

  private assertStatus(allowed: OrderStatus[], action: string): void {
    if (!allowed.includes(this.status)) {
      throw new InvalidOrderTransitionError(this.status, action);
    }
  }

  private static totalOf(items: OrderItem[]): number {
    return fromCents(
      items.reduce((sum, item) => sum + item.qty * toCents(item.unitPrice), 0),
    );
  }

  /** Domain invariants. The HTTP DTO validates the contract first; this guards every other caller. */
  private static validated(props: NewOrderProps): NewOrderProps {
    if (!props.orderId?.trim())
      throw new InvalidOrderError('orderId is required');
    if (!props.idempotencyKey?.trim())
      throw new InvalidOrderError('idempotencyKey is required');
    if (props.items.length === 0)
      throw new InvalidOrderError('an order needs at least one item');
    for (const item of props.items) {
      if (!Number.isInteger(item.qty) || item.qty <= 0) {
        throw new InvalidOrderError(
          `qty of ${item.sku} must be a positive integer`,
        );
      }
      if (item.unitPrice < 0) {
        throw new InvalidOrderError(
          `unitPrice of ${item.sku} cannot be negative`,
        );
      }
    }
    return { ...props, currency: props.currency.trim().toUpperCase() };
  }
}
