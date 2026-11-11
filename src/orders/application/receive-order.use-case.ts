import { Order, type NewOrderProps } from '../domain/order.js';
import { FailureReason, OrderStatus } from '../domain/order-status.js';
import { EnrichmentQueue } from './ports/enrichment.queue.js';
import {
  DuplicateOrderError,
  OrderRepository,
} from './ports/order.repository.js';
import { SupportedCurrencies } from './ports/supported-currencies.js';

export type ReceiveOrderCommand = NewOrderProps & { requestId: string };

export interface ReceiveOrderSettings {
  /** What to do when an order_id arrives again under a new idempotency key. */
  duplicatePolicy: 'reject' | 'update';
  maxRevisions: number;
  /**
   * Waits between enqueue attempts inside the request (e.g. [100, 200, 400] = 4 attempts).
   * Short on purpose: the HTTP client is waiting. Longer outages are left to the sweeper.
   */
  enqueueRetryDelaysMs: number[];
}

/** created → 202, duplicate → 200, updated → 202 */
export interface ReceiveOrderResult {
  outcome: 'created' | 'duplicate' | 'updated';
  order: Order;
  /**
   * The order is stored and needs a job, but the queue was unreachable after every retry.
   * Still a success for the client: the order is durable and the sweeper enqueues it.
   */
  pendingEnqueue: boolean;
  /** Why the enqueue failed, for logs and metrics. */
  enqueueError?: unknown;
}

type EnqueueOutcome = Pick<
  ReceiveOrderResult,
  'pendingEnqueue' | 'enqueueError'
>;
const NOTHING_PENDING: EnqueueOutcome = { pendingEnqueue: false };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Same order_id, different idempotency key, policy=reject. */
export class OrderAlreadyExistsError extends Error {
  override name = 'OrderAlreadyExistsError';
  constructor(readonly orderId: string) {
    super(`Order ${orderId} was already received with another idempotency key`);
  }
}

/** The key belongs to another order: the client reused a key for a different operation. */
export class IdempotencyKeyReusedError extends Error {
  override name = 'IdempotencyKeyReusedError';
  constructor(readonly idempotencyKey: string) {
    super(
      `Idempotency key ${idempotencyKey} was already used for a different order`,
    );
  }
}

/**
 * Webhook intake. Idempotency is decided here, but guaranteed by the repository's
 * unique indexes: when two requests race past the lookups, the insert of the loser
 * fails and the request is evaluated again against what the winner stored.
 */
export class ReceiveOrder {
  constructor(
    private readonly orders: OrderRepository,
    private readonly queue: EnrichmentQueue,
    private readonly currencies: SupportedCurrencies,
    private readonly settings: ReceiveOrderSettings,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  execute(command: ReceiveOrderCommand): Promise<ReceiveOrderResult> {
    return this.receive(command, { afterRace: false });
  }

  private async receive(
    command: ReceiveOrderCommand,
    { afterRace }: { afterRace: boolean },
  ): Promise<ReceiveOrderResult> {
    const sameKey = await this.orders.findByIdempotencyKey(
      command.idempotencyKey,
    );
    if (sameKey) return this.duplicate(sameKey, command);

    const sameOrderId = await this.orders.findByOrderId(command.orderId);
    if (sameOrderId) return this.update(sameOrderId, command);

    try {
      return await this.create(command);
    } catch (error) {
      // Lost a race on a unique index: decide again, now seeing the winner's order.
      if (error instanceof DuplicateOrderError && !afterRace) {
        return this.receive(command, { afterRace: true });
      }
      throw error;
    }
  }

  private async create(
    command: ReceiveOrderCommand,
  ): Promise<ReceiveOrderResult> {
    const received = Order.receive(command);
    const supported = await this.rejectIfUnsupportedCurrency(received);

    const order = await this.orders.insert(received);
    const enqueued = supported
      ? await this.enqueue(order, command.requestId)
      : NOTHING_PENDING;
    return { outcome: 'created', order, ...enqueued };
  }

  private async duplicate(
    order: Order,
    command: ReceiveOrderCommand,
  ): Promise<ReceiveOrderResult> {
    if (order.orderId !== command.orderId) {
      throw new IdempotencyKeyReusedError(command.idempotencyKey);
    }
    // Still RECEIVED means no worker picked it up: maybe the first enqueue failed
    // after the insert. Enqueuing again is safe, the queue dedups by jobId.
    const enqueued =
      order.status === OrderStatus.RECEIVED
        ? await this.enqueue(order, command.requestId)
        : NOTHING_PENDING;
    return { outcome: 'duplicate', order, ...enqueued };
  }

  private async update(
    order: Order,
    command: ReceiveOrderCommand,
  ): Promise<ReceiveOrderResult> {
    if (this.settings.duplicatePolicy === 'reject') {
      throw new OrderAlreadyExistsError(command.orderId);
    }

    const expectedRevision = order.revision;
    const { requiresEnqueue } = order.applyUpdate(command, {
      maxRevisions: this.settings.maxRevisions,
    });
    const supported = await this.rejectIfUnsupportedCurrency(order);

    await this.orders.update(order, expectedRevision);
    const enqueued =
      supported && requiresEnqueue
        ? await this.enqueue(order, command.requestId)
        : NOTHING_PENDING;
    return { outcome: 'updated', order, ...enqueued };
  }

  /** Unsupported currencies fail at intake: no job, no worker time, no provider call. */
  private async rejectIfUnsupportedCurrency(order: Order): Promise<boolean> {
    const supported = await this.currencies.isSupported(order.currency);
    if (!supported) {
      order.failEnrichment(FailureReason.UNSUPPORTED_CURRENCY, {
        retryable: false,
      });
    }
    return supported;
  }

  /**
   * Runs after the order is stored, so a queue failure must not fail the request:
   * retries a few times, then reports the enqueue as pending (sweeper takes over).
   *
   * Waiting only helps while the queue still looks up (a frozen Redis timing out).
   * Once the client knows the connection is down, the client would just sleep:
   * give up at once and leave the order to the sweeper.
   */
  private async enqueue(
    order: Order,
    requestId: string,
  ): Promise<EnqueueOutcome> {
    const job = {
      jobId: order.currentIdempotencyKey,
      orderId: order.id!,
      requestId,
    };
    const delays = this.settings.enqueueRetryDelaysMs;
    let lastError: unknown = new Error('Enrichment queue is unavailable');

    for (let attempt = 0; ; attempt++) {
      if (!this.queue.isAvailable()) {
        return { pendingEnqueue: true, enqueueError: lastError };
      }
      try {
        await this.queue.enqueue(job);
        return NOTHING_PENDING;
      } catch (error) {
        lastError = error;
        if (attempt >= delays.length)
          return { pendingEnqueue: true, enqueueError: error };
        await this.wait(delays[attempt]!);
      }
    }
  }
}
