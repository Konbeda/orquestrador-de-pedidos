import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type {
  EnrichOrderCommand,
  EnrichOrderResult,
} from '../../application/enrich-order.use-case.js';
import { ENRICHMENT_QUEUE_NAME } from './bullmq-enrichment.queue.js';
import {
  EnrichmentJobProcessor,
  ReleaseJobForSweeper,
  type DeadLetter,
} from './enrichment-job.processor.js';

export const DEAD_LETTER_QUEUE_NAME = 'orders-enrichment-dlq';

export interface EnrichmentWorkerSettings {
  host: string;
  port: number;
  concurrency: number;
  /** How long the whole queue holds when the exchange provider is down (circuit open). */
  pauseWhenProviderDownMs: number;
}

/**
 * Consumer side of the enrichment queue. Unlike the producer it does not fail
 * fast: a worker should ride out Redis restarts and keep reconnecting
 * (BullMQ requires maxRetriesPerRequest: null for its blocking connection).
 */
export class EnrichmentWorker {
  private readonly logger = new Logger(EnrichmentWorker.name);
  private readonly redis: Redis;
  private readonly queue: Queue;
  private readonly deadLetters: Queue;
  private readonly worker: Worker;

  constructor(
    enrichOrder: {
      execute(command: EnrichOrderCommand): Promise<EnrichOrderResult>;
    },
    settings: EnrichmentWorkerSettings,
  ) {
    const connect = () =>
      new Redis({
        host: settings.host,
        port: settings.port,
        maxRetriesPerRequest: null,
      });
    this.redis = connect();
    this.queue = new Queue(ENRICHMENT_QUEUE_NAME, { connection: this.redis });
    // Nobody consumes the DLQ: it is the record of what failed for good, for inspection
    // and metrics. Same jobId as the failed job, so a duplicate copy is ignored.
    this.deadLetters = new Queue(DEAD_LETTER_QUEUE_NAME, {
      connection: this.redis,
    });

    const processor = new EnrichmentJobProcessor(
      enrichOrder,
      {
        add: async (entry: DeadLetter) => {
          await this.deadLetters.add('dead-letter', entry, {
            jobId: entry.jobId,
          });
        },
      },
      // Queue-wide: every worker instance holds, not only this one.
      { pauseFor: (ms) => this.queue.rateLimit(ms) },
      { pauseWhenProviderDownMs: settings.pauseWhenProviderDownMs },
    );

    this.worker = new Worker(
      ENRICHMENT_QUEUE_NAME,
      (job) => processor.process(job),
      {
        connection: connect(),
        concurrency: settings.concurrency,
        autorun: false,
      },
    );
    this.watch();
  }

  start(): void {
    this.worker.run().catch((error: unknown) => {
      this.logger.error(
        { err: error },
        'Enrichment worker stopped unexpectedly',
      );
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.deadLetters.close();
    this.redis.disconnect();
  }

  private watch(): void {
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const context = {
        job: job.id,
        order: job.data?.orderId,
        request_id: job.data?.requestId,
      };
      if (error instanceof ReleaseJobForSweeper) {
        // Free the jobId: a kept failed job would dedup the sweeper's enqueue.
        job
          .remove()
          .catch((err: unknown) =>
            this.logger.error(
              { ...context, err },
              'Could not release failed job for the sweeper',
            ),
          );
        this.logger.warn({ ...context, err: error }, error.message);
        return;
      }
      this.logger.warn(
        { ...context, err: error, attempts: job.attemptsMade },
        'Enrichment job failed',
      );
    });
    this.worker.on('error', (error) => {
      this.logger.error({ err: error }, 'Enrichment worker error');
    });
  }
}
