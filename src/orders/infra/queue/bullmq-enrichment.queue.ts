import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  EnrichmentQueue,
  type EnrichmentJob,
} from '../../application/ports/enrichment.queue.js';

export const ENRICHMENT_QUEUE_NAME = 'orders-enrichment';
const ENRICH_JOB = 'enrich';

export interface BullMqEnrichmentQueueSettings {
  host: string;
  port: number;
  /** A command Redis does not answer within this time is failed (frozen Redis). */
  commandTimeoutMs: number;
  attempts: number;
  /** Base delay of the exponential backoff between attempts. */
  backoffMs: number;
}

export class QueueUnavailableError extends Error {
  override name = 'QueueUnavailableError';
  constructor(reason: string) {
    super(`Enrichment queue unavailable: ${reason}`);
  }
}

/**
 * BullMQ rejects custom job ids that look like integers or contain ':'.
 * Idempotency keys come from clients, so they are encoded: base64url has
 * neither, the prefix keeps it from being numeric, and it stays collision-free.
 */
export const toJobId = (idempotencyKey: string): string =>
  `k_${Buffer.from(idempotencyKey, 'utf8').toString('base64url')}`;

/**
 * Producer side of the enrichment queue, tuned to fail fast: a webhook request
 * is waiting on it, and callers already know what to do when the enqueue fails
 * (retry briefly, then leave the order to the sweeper).
 *
 * Measured with default settings, an enqueue against a stopped or frozen Redis
 * hangs for good; with these it fails in ~1 ms (stopped) or `commandTimeoutMs` (frozen).
 */
export class BullMqEnrichmentQueue extends EnrichmentQueue {
  private readonly logger = new Logger(BullMqEnrichmentQueue.name);
  private readonly redis: Redis;
  private readonly queue: Queue;
  private wasReady = false;

  constructor(private readonly settings: BullMqEnrichmentQueueSettings) {
    super();
    this.redis = new Redis({
      host: settings.host,
      port: settings.port,
      // Fail commands while disconnected instead of buffering them until Redis returns.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      // A frozen Redis keeps the TCP connection open; only a timeout notices it.
      commandTimeout: settings.commandTimeoutMs,
      connectTimeout: settings.commandTimeoutMs * 2,
      // Keep reconnecting in the background, at most every 2 s.
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });
    this.queue = new Queue(ENRICHMENT_QUEUE_NAME, {
      connection: this.redis,
      defaultJobOptions: {
        attempts: settings.attempts,
        backoff: { type: 'exponential', delay: settings.backoffMs },
        // Completed jobs stay a day: their ids keep deduplicating late retries.
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    });
    this.watchConnection();
  }

  isAvailable(): boolean {
    return this.redis.status === 'ready';
  }

  async enqueue(job: EnrichmentJob): Promise<void> {
    // BullMQ waits for the connection to become ready before sending anything,
    // even with the offline queue disabled: never hand it a command while down.
    if (!this.isAvailable()) {
      throw new QueueUnavailableError(`redis is ${this.redis.status}`);
    }
    await this.queue.add(
      ENRICH_JOB,
      { orderId: job.orderId, requestId: job.requestId },
      { jobId: toJobId(job.jobId) },
    );
  }

  async close(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.redis.disconnect();
  }

  /** Logs state changes once, instead of one error per reconnect attempt. */
  private watchConnection(): void {
    const ignore = () => undefined;
    this.redis.on('error', ignore);
    this.queue.on('error', ignore);
    this.redis.on('ready', () => {
      this.wasReady = true;
      this.logger.log('Connected to Redis');
    });
    this.redis.on('close', () => {
      if (!this.wasReady) return;
      this.wasReady = false;
      this.logger.warn(
        'Lost connection to Redis; enqueues fail fast until it returns',
      );
    });
  }
}
