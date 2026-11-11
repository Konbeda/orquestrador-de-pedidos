import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema.js';
import { EnrichOrder } from '../../application/enrich-order.use-case.js';
import { EnrichmentWorker } from './enrichment.worker.js';

/**
 * Starts the enrichment worker inside this process when WORKER_ENABLED=true.
 * With false, the process only serves HTTP and workers run elsewhere (same image,
 * other env), so API and processing scale independently.
 */
@Injectable()
export class EnrichmentWorkerRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EnrichmentWorkerRunner.name);
  private worker: EnrichmentWorker | null = null;

  constructor(
    private readonly enrichOrder: EnrichOrder,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      this.logger.log(
        'WORKER_ENABLED=false: enrichment worker not started in this process',
      );
      return;
    }
    this.worker = new EnrichmentWorker(this.enrichOrder, {
      host: this.config.get('REDIS_HOST', { infer: true }),
      port: this.config.get('REDIS_PORT', { infer: true }),
      concurrency: this.config.get('ENRICHMENT_CONCURRENCY', { infer: true }),
      // Hold the queue as long as the circuit stays open.
      pauseWhenProviderDownMs: this.config.get('CIRCUIT_RESET_TIMEOUT_MS', {
        infer: true,
      }),
    });
    this.worker.start();
    this.logger.log('Enrichment worker started');
  }

  /** Waits for in-flight jobs to finish (BullMQ close) before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
