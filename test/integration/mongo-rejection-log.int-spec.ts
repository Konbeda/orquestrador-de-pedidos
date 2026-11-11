import { randomUUID } from 'node:crypto';
import mongoose, { type Connection } from 'mongoose';
import { inject } from 'vitest';
import { buildRejectionRecord } from '../../src/rejections/rejection-record.js';
import {
  MongoRejectionLog,
  REJECTIONS_COLLECTION,
} from '../../src/rejections/mongo-rejection-log.js';

const DAY_SECONDS = 24 * 60 * 60;

const record = (requestId: string, source: string, receivedAt: Date) =>
  buildRejectionRecord({
    requestId,
    receivedAt,
    source,
    userAgent: 'partner/1.0',
    kind: 'INVALID_PAYLOAD',
    rawBody: Buffer.from('{"currency":"dolar"}'),
    parsedBody: { currency: 'dolar', customer: { email: 'user@example.com' } },
    errors: [
      {
        field: 'currency',
        message: 'bad',
        constraint: 'isISO4217CurrencyCode',
      },
    ],
  });

describe('MongoRejectionLog (integration)', () => {
  let connection: Connection;

  const log = (retentionDays = 90) =>
    new MongoRejectionLog(connection.collection(REJECTIONS_COLLECTION), {
      retentionDays,
    });
  const indexes = async () => {
    const list = await connection.collection(REJECTIONS_COLLECTION).indexes();
    return Object.fromEntries(
      list.map((index) => [JSON.stringify(index.key), index]),
    );
  };

  beforeEach(async () => {
    const name = `rejections_${randomUUID().replaceAll('-', '')}`;
    connection = await mongoose
      .createConnection(inject('mongoUri').replace(/\/(\?|$)/, `/${name}$1`))
      .asPromise();
  });

  afterEach(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  describe('indexes', () => {
    it('creates the lookup indexes and the TTL that deletes records after the retention', async () => {
      await log(90).ensureIndexes();

      const byKey = await indexes();
      // Not unique: request ids may come from the client (x-request-id) and repeat.
      expect(byKey['{"request_id":1}']).toBeDefined();
      expect(byKey['{"request_id":1}']!.unique).toBeUndefined();
      expect(byKey['{"source":1,"received_at":-1}']).toBeDefined();
      expect(byKey['{"received_at":1}']).toMatchObject({
        expireAfterSeconds: 90 * DAY_SECONDS,
      });
    });

    it('applies a changed retention to the existing TTL index (Mongo refuses to recreate it)', async () => {
      await log(90).ensureIndexes();

      await log(30).ensureIndexes();

      expect((await indexes())['{"received_at":1}']).toMatchObject({
        expireAfterSeconds: 30 * DAY_SECONDS,
      });
    });

    it('is idempotent: running it twice with the same retention changes nothing', async () => {
      await log(90).ensureIndexes();
      await expect(log(90).ensureIndexes()).resolves.toBeUndefined();
    });
  });

  describe('records', () => {
    it('stores a record and finds it by request id', async () => {
      const rejections = log();
      await rejections.ensureIndexes();
      const stored = record('req_1', '10.0.0.7', new Date());

      await rejections.record(stored);

      expect(await rejections.findByRequestId('req_1')).toEqual([stored]);
      expect(await rejections.findByRequestId('req_404')).toEqual([]);
    });

    it('keeps every record when a client reuses a request id', async () => {
      const rejections = log();
      await rejections.ensureIndexes();

      await rejections.record(
        record('req_dup', '10.0.0.7', new Date('2026-11-11T10:00:00Z')),
      );
      await rejections.record(
        record('req_dup', '10.0.0.7', new Date('2026-11-11T11:00:00Z')),
      );

      expect(await rejections.findByRequestId('req_dup')).toHaveLength(2);
    });

    it('lists by source within a period, newest first', async () => {
      const rejections = log();
      await rejections.ensureIndexes();
      const at = (hour: number) =>
        new Date(`2026-11-11T${String(hour).padStart(2, '0')}:00:00Z`);
      await rejections.record(record('r8', 'partner-a', at(8)));
      await rejections.record(record('r10', 'partner-a', at(10)));
      await rejections.record(record('r12', 'partner-a', at(12)));
      await rejections.record(record('r13', 'partner-a', at(13))); // `to` is exclusive
      await rejections.record(record('r11', 'partner-b', at(11)));

      const found = await rejections.listBySource({
        source: 'partner-a',
        from: at(9),
        to: at(13),
        limit: 50,
      });

      expect(found.map((r) => r.request_id)).toEqual(['r12', 'r10']);
    });

    it('never stores the raw email (only the masked one)', async () => {
      const rejections = log();
      await rejections.ensureIndexes();
      await rejections.record(record('req_pii', '10.0.0.7', new Date()));

      const raw = await connection
        .collection(REJECTIONS_COLLECTION)
        .findOne({ request_id: 'req_pii' });

      expect(JSON.stringify(raw)).not.toContain('user@example.com');
      expect(JSON.stringify(raw)).toContain('u***@example.com');
    });
  });
});
