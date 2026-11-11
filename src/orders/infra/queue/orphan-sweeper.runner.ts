import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema.js';
import {
  EnqueueStaleOrders,
  type EnqueueStaleOrdersResult,
} from '../../application/enqueue-stale-orders.use-case.js';
import { PeriodicTask } from '../../../shared/scheduling/periodic-task.js';

/**
 * Runs the orphan sweeper every SWEEP_INTERVAL_MS in processes with the
 * processing role (WORKER_ENABLED=true). Several instances sweeping at once is
 * safe (the queue dedups by jobId); it only costs extra queries.
 */
@Injectable()
export class OrphanSweeperRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OrphanSweeperRunner.name);
  private task: PeriodicTask<EnqueueStaleOrdersResult> | null = null;

  constructor(
    private readonly sweep: EnqueueStaleOrders,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) return;

    this.task = new PeriodicTask(() => this.sweep.execute(), {
      intervalMs: this.config.get('SWEEP_INTERVAL_MS', { infer: true }),
      onResult: (result) => this.report(result),
      onError: (error) =>
        this.logger.error({ err: error }, 'Orphan sweep failed'),
    });
    this.task.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.task?.stop();
  }

  /** Quiet when there was nothing to do; one line when it acted or could not. */
  private report(result: EnqueueStaleOrdersResult): void {
    if (result.skipped) {
      this.logger.warn('Orphan sweep skipped: enrichment queue unavailable');
    } else if (result.error) {
      this.logger.warn(
        { err: result.error, enqueued: result.enqueued },
        'Orphan sweep stopped early: enqueue failed',
      );
    } else if (result.enqueued > 0) {
      this.logger.warn(
        { enqueued: result.enqueued },
        'Orphan sweep re-enqueued orders',
      );
    }
  }
}
