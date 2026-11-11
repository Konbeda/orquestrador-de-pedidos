import { RateLimitError, UnrecoverableError } from 'bullmq';
import {
  EnrichmentFailed,
  ExchangeProviderPaused,
  type EnrichOrderCommand,
  type EnrichOrderResult,
} from '../../application/enrich-order.use-case.js';

/** The parts of a BullMQ job the processor reads (keeps the unit tests Redis-free). */
export interface EnrichmentJobLike {
  id?: string;
  data: { orderId: string; requestId: string };
  /** Attempts already made before this run (0 on the first run). */
  attemptsMade: number;
  opts: { attempts?: number };
}

export interface DeadLetter {
  jobId: string;
  orderId: string;
  requestId: string;
  reason: string;
  error: string;
  /** How many runs the job had, this one included. */
  attempts: number;
  failedAt: string;
}

export interface DeadLetterSink {
  add(entry: DeadLetter): Promise<void>;
}

export interface QueuePause {
  /** Stops every worker of the queue from taking jobs for `ms`. */
  pauseFor(ms: number): Promise<void>;
}

export interface EnrichmentJobProcessorSettings {
  /** How long to hold the queue when the exchange provider is known to be down. */
  pauseWhenProviderDownMs: number;
}

/**
 * Thrown on the last attempt when the order is still RECEIVED (not failed):
 * the worker deletes the failed job, so its jobId is free again and the orphan
 * sweeper can enqueue the order. Otherwise BullMQ would keep the failed job
 * (removeOnFail) and silently dedup the sweeper's enqueue for days.
 */
export class ReleaseJobForSweeper extends Error {
  override name = 'ReleaseJobForSweeper';
  constructor(override readonly cause: unknown) {
    super(
      `Attempts exhausted with the order still RECEIVED; left to the orphan sweeper: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/**
 * Translates how EnrichOrder ended into what BullMQ understands:
 *
 *   enriched / skipped           → job completes
 *   ExchangeProviderPaused       → pause the queue + RateLimitError (no attempt spent)
 *   EnrichmentFailed             → copy to the DLQ + UnrecoverableError (no more retries)
 *   anything else, attempts left → rethrow: BullMQ retries with exponential backoff
 *   anything else, last attempt  → ReleaseJobForSweeper
 */
export class EnrichmentJobProcessor {
  constructor(
    private readonly enrichOrder: {
      execute(command: EnrichOrderCommand): Promise<EnrichOrderResult>;
    },
    private readonly deadLetters: DeadLetterSink,
    private readonly queue: QueuePause,
    private readonly settings: EnrichmentJobProcessorSettings,
  ) {}

  async process(job: EnrichmentJobLike): Promise<EnrichOrderResult> {
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    try {
      return await this.enrichOrder.execute({
        orderId: job.data.orderId,
        attempt,
        maxAttempts,
      });
    } catch (error) {
      if (error instanceof ExchangeProviderPaused) {
        await this.queue.pauseFor(this.settings.pauseWhenProviderDownMs);
        throw new RateLimitError();
      }
      if (error instanceof EnrichmentFailed) {
        await this.deadLetters.add({
          jobId: job.id ?? 'unknown',
          orderId: job.data.orderId,
          requestId: job.data.requestId,
          reason: error.reason,
          error: error.message,
          attempts: attempt,
          failedAt: new Date().toISOString(),
        });
        throw new UnrecoverableError(error.message);
      }
      if (attempt >= maxAttempts) throw new ReleaseJobForSweeper(error);
      throw error;
    }
  }
}
