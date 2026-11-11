import type { Connection } from 'mongoose';
import { RejectionLog, type RejectionsBySourceQuery } from './rejection-log.js';
import type { RejectionRecord } from './rejection-record.js';

export const REJECTIONS_COLLECTION = 'webhook_rejections';

type Collection = ReturnType<Connection['collection']>;

const DAY_SECONDS = 24 * 60 * 60;
/** Mongo refuses to recreate an index with different options (e.g. another TTL). */
const INDEX_OPTIONS_CONFLICT = new Set([85, 86]);
const WITHOUT_ID = { projection: { _id: 0 } } as const;

/**
 * Plain driver collection, no Mongoose model: these are write-mostly records
 * with no domain behind them. Indexes (README: "Índices"):
 *   request_id               support lookups ("what happened to req_x?"), not unique
 *   { source, received_at }  "rejections of partner X in this period"
 *   received_at (TTL)        export by period + automatic deletion after the retention (LGPD)
 */
export class MongoRejectionLog extends RejectionLog {
  constructor(
    private readonly collection: Collection,
    private readonly settings: { retentionDays: number },
  ) {
    super();
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ request_id: 1 });
    await this.collection.createIndex({ source: 1, received_at: -1 });

    const expireAfterSeconds = this.settings.retentionDays * DAY_SECONDS;
    try {
      await this.collection.createIndex(
        { received_at: 1 },
        { expireAfterSeconds },
      );
    } catch (error) {
      if (!INDEX_OPTIONS_CONFLICT.has((error as { code?: number }).code ?? 0))
        throw error;
      // The retention changed: update the existing TTL index in place.
      await this.collection.conn.db!.command({
        collMod: this.collection.collectionName,
        index: { keyPattern: { received_at: 1 }, expireAfterSeconds },
      });
    }
  }

  async record(record: RejectionRecord): Promise<void> {
    // insertOne adds _id to the object it receives: give it a copy.
    await this.collection.insertOne({ ...record });
  }

  async findByRequestId(requestId: string): Promise<RejectionRecord[]> {
    return (await this.collection
      .find({ request_id: requestId }, WITHOUT_ID)
      .sort({ received_at: -1 })
      .toArray()) as unknown as RejectionRecord[];
  }

  async listBySource({
    source,
    from,
    to,
    limit,
  }: RejectionsBySourceQuery): Promise<RejectionRecord[]> {
    return (await this.collection
      .find({ source, received_at: { $gte: from, $lt: to } }, WITHOUT_ID)
      .sort({ received_at: -1 })
      .limit(limit)
      .toArray()) as unknown as RejectionRecord[];
  }
}
