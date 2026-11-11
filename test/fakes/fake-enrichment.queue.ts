import {
  EnrichmentQueue,
  type EnrichmentJob,
} from '../../src/orders/application/ports/enrichment.queue.js';

/** Records jobs and, like BullMQ, ignores a jobId it already holds. */
export class FakeEnrichmentQueue extends EnrichmentQueue {
  readonly jobs: EnrichmentJob[] = [];
  /** Every enqueue call, including the ones that failed. */
  attempts = 0;
  private failuresLeft = 0;

  async enqueue(job: EnrichmentJob): Promise<void> {
    this.attempts += 1;
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('Redis unavailable');
    }
    if (this.jobs.some((j) => j.jobId === job.jobId)) return;
    this.jobs.push(job);
  }

  /** The next `times` enqueue calls fail, as if Redis were down. `Infinity` keeps it down. */
  failNext(times = 1): void {
    this.failuresLeft = times;
  }

  /** Redis is back. */
  recover(): void {
    this.failuresLeft = 0;
  }
}
