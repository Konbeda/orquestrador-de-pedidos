import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  EnrichmentQueue,
  type EnrichmentJob,
} from '../../application/ports/enrichment.queue.js';

export const ENRICHMENT_QUEUE_NAME = 'orders-enrichment';
/** Final failures, copied by the worker. Nobody consumes it. */
export const DEAD_LETTER_QUEUE_NAME = 'orders-enrichment-dlq';
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

export interface EnrichmentQueueMetrics {
  enrichment: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    paused_for_ms: number;
  };
  dead_letter: { total: number };
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
  private readonly deadLetters: Queue;
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
    this.deadLetters = new Queue(DEAD_LETTER_QUEUE_NAME, {
      connection: this.redis,
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

  /** For GET /queue/metrics. Fails fast (QueueUnavailableError) with Redis down. */
  async metrics(): Promise<EnrichmentQueueMetrics> {
    if (!this.isAvailable()) {
      throw new QueueUnavailableError(`redis is ${this.redis.status}`);
    }
    const [counts, pauseTtl, deadLetters] = await Promise.all([
      this.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      ),
      this.queue.getRateLimitTtl(),
      // Dead letters are never consumed: they all sit in waiting.
      this.deadLetters.getJobCountByTypes('waiting'),
    ]);
    return {
      enrichment: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        // Remaining pause set by the open circuit (negative = no pause key).
        paused_for_ms: Math.max(0, pauseTtl),
      },
      dead_letter: { total: deadLetters },
    };
  }

  async close(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.deadLetters.close().catch(() => undefined);
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
