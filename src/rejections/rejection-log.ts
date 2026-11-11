import type { RejectionRecord } from './rejection-record.js';

export interface RejectionsBySourceQuery {
  source: string;
  from: Date;
  to: Date;
  limit: number;
}

/** Audit trail of refused webhooks (webhook_rejections). */
export abstract class RejectionLog {
  abstract record(record: RejectionRecord): Promise<void>;
  /** A list: request ids may come from the client and repeat. */
  abstract findByRequestId(requestId: string): Promise<RejectionRecord[]>;
  /** Newest first, `from` inclusive, `to` exclusive. */
  abstract listBySource(
    query: RejectionsBySourceQuery,
  ): Promise<RejectionRecord[]>;
}
