import { EnrichmentQueue } from './ports/enrichment.queue.js';
import { OrderRepository } from './ports/order.repository.js';

export interface EnqueueStaleOrdersSettings {
  /** A RECEIVED order not checked against the queue for this long is considered orphaned. */
  staleAfterMs: number;
  batchSize: number;
}

export interface EnqueueStaleOrdersResult {
  enqueued: number;
  /** Set when the run stopped early because the queue refused an enqueue. */
  error?: unknown;
  /** Set when the run did nothing because the queue was known to be down. */
  skipped?: 'queue_unavailable';
}

/**
 * Orphan sweeper: finds RECEIVED orders that may have no job (the enqueue failed
 * after the insert and the client never retried) and enqueues them.
 *
 * Safe to run any number of times: the queue dedups by jobId, and a job that
 * runs twice is a no-op in the worker once the order left RECEIVED.
 */
export class EnqueueStaleOrders {
  constructor(
    private readonly orders: OrderRepository,
    private readonly queue: EnrichmentQueue,
    private readonly settings: EnqueueStaleOrdersSettings,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<EnqueueStaleOrdersResult> {
    // Nothing could be enqueued: do not even query Mongo.
    if (!this.queue.isAvailable()) {
      return { enqueued: 0, skipped: 'queue_unavailable' };
    }

    const now = this.clock();
    const cutoff = new Date(now.getTime() - this.settings.staleAfterMs);
    const requestId = `sweeper:${now.toISOString()}`;
    // Guards against looping forever if a stamp is not refreshed.
    const seen = new Set<string>();
    let enqueued = 0;

    for (;;) {
      const batch = await this.orders.findStaleReceived(
        cutoff,
        this.settings.batchSize,
      );
      const fresh = batch.filter((order) => !seen.has(order.id!));
      if (fresh.length === 0) return { enqueued };

      const done: string[] = [];
      for (const order of fresh) {
        seen.add(order.id!);
        try {
          await this.queue.enqueue({
            jobId: order.currentIdempotencyKey,
            orderId: order.id!,
            requestId,
          });
        } catch (error) {
          // The queue is most likely down: stop here, the next run picks up the rest.
          await this.orders.markQueueChecked(done, now);
          return { enqueued, error };
        }
        done.push(order.id!);
        enqueued += 1;
      }
      await this.orders.markQueueChecked(done, now);

      if (batch.length < this.settings.batchSize) return { enqueued };
    }
  }
}
