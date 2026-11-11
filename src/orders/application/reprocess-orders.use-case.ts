import { ReprocessNotAllowedError, type Order } from '../domain/order.js';
import { EnrichmentQueue } from './ports/enrichment.queue.js';
import {
  ConcurrentUpdateError,
  OrderRepository,
} from './ports/order.repository.js';

export interface ReprocessOrdersCommand {
  /** Specific orders (internal ids). Without it: every retryable failure, oldest first. */
  orderIds?: string[];
  limit: number;
  requestId: string;
}

export type ReprocessSkipReason =
  | 'NOT_FOUND'
  | 'NOT_FAILED'
  | 'NOT_RETRYABLE'
  | 'LIMIT_REACHED'
  | 'CONCURRENT_UPDATE';

export interface ReprocessOrdersResult {
  /** pendingEnqueue: stored as RECEIVED but the queue refused; the orphan sweeper enqueues it. */
  reprocessed: Array<{ id: string; pendingEnqueue: boolean }>;
  skipped: Array<{ id: string; reason: ReprocessSkipReason }>;
}

/**
 * Sends FAILED_ENRICHMENT orders back for another enrichment (e.g. after
 * Frankfurter came back). Each order: domain check (retryable, under the limit)
 * → stored as RECEIVED → enqueued with low priority under a new job key.
 */
export class ReprocessOrders {
  constructor(
    private readonly orders: OrderRepository,
    private readonly queue: EnrichmentQueue,
    private readonly settings: { maxReprocessCount: number },
  ) {}

  async execute(
    command: ReprocessOrdersCommand,
  ): Promise<ReprocessOrdersResult> {
    const result: ReprocessOrdersResult = { reprocessed: [], skipped: [] };
    const targets = command.orderIds
      ? await Promise.all(
          command.orderIds.map(async (id) => ({
            id,
            order: await this.orders.findById(id),
          })),
        )
      : (
          await this.orders.findRetryableFailures({
            limit: command.limit,
            maxReprocessCount: this.settings.maxReprocessCount,
          })
        ).map((order) => ({ id: order.id!, order }));

    // One at a time: a reprocess batch must not burst the queue nor the database.
    for (const { id, order } of targets) {
      if (!order) {
        result.skipped.push({ id, reason: 'NOT_FOUND' });
        continue;
      }
      const outcome = await this.reprocess(order, command.requestId);
      if (typeof outcome === 'string')
        result.skipped.push({ id, reason: outcome });
      else
        result.reprocessed.push({ id, pendingEnqueue: outcome.pendingEnqueue });
    }
    return result;
  }

  private async reprocess(
    order: Order,
    requestId: string,
  ): Promise<{ pendingEnqueue: boolean } | ReprocessSkipReason> {
    const revision = order.revision;
    try {
      order.requeueForReprocess({
        maxReprocessCount: this.settings.maxReprocessCount,
      });
      await this.orders.update(order, revision);
    } catch (error) {
      if (error instanceof ReprocessNotAllowedError) return error.reason;
      if (error instanceof ConcurrentUpdateError) return 'CONCURRENT_UPDATE';
      throw error;
    }

    try {
      await this.queue.enqueue({
        jobId: order.jobKey,
        orderId: order.id!,
        requestId,
        priority: 'low',
      });
      return { pendingEnqueue: false };
    } catch {
      // Already stored as RECEIVED and stamped: the orphan sweeper enqueues it later.
      return { pendingEnqueue: true };
    }
  }
}
