export interface EnrichmentJob {
  /** Queue-level dedup: a job with an existing jobId is ignored. We use the idempotency key. */
  jobId: string;
  /** Internal (database) id of the order to enrich. */
  orderId: string;
  /** Correlates the job's logs with the HTTP request that created it. */
  requestId: string;
}

export abstract class EnrichmentQueue {
  /**
   * Connection state as the client already knows it (no network round trip).
   * An optimization only: true does not guarantee the next enqueue succeeds,
   * so callers must still handle enqueue failures.
   */
  abstract isAvailable(): boolean;

  /** Must be idempotent per jobId: enqueuing the same jobId twice creates one job. */
  abstract enqueue(job: EnrichmentJob): Promise<void>;
}
