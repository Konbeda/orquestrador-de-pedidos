import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import type { Connection } from 'mongoose';
import nock from 'nock';
import request from 'supertest';
import { inject } from 'vitest';
import {
  ENRICHMENT_QUEUE_NAME,
  toJobId,
} from '../../src/orders/infra/queue/bullmq-enrichment.queue.js';
import { createTestApp } from '../helpers/test-app.js';

const FRANKFURTER = 'https://frankfurter.test';

let sequence = 0;
/** A valid payload with unique ids, so tests never collide. */
function payload(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    order_id: `ext-${sequence}-${Date.now()}`,
    customer: { email: 'user@example.com', name: 'Ana' },
    items: [{ sku: 'ABC123', qty: 2, unit_price: 59.9 }],
    currency: 'USD',
    idempotency_key: `key-${sequence}-${Date.now()}`,
    ...overrides,
  };
}

describe('POST /webhooks/orders (e2e)', () => {
  let app: INestApplication;
  let orders: ReturnType<Connection['collection']>;
  let queue: Queue;

  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/webhooks/orders')
      .send(body as object);
  const jobsFor = async (idempotencyKey: string) =>
    (await queue.getJobs(['waiting', 'delayed', 'active'])).filter(
      (job) => job.id === toJobId(idempotencyKey),
    );

  beforeAll(async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, {
        BRL: 'Brazilian Real',
        EUR: 'Euro',
        USD: 'United States Dollar',
      })
      .persist();
    app = await createTestApp({
      FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1`,
      BODY_LIMIT: '2kb',
    });
    orders = app.get<Connection>(getConnectionToken()).collection('orders');
    queue = new Queue(ENRICHMENT_QUEUE_NAME, {
      connection: { host: inject('redisHost'), port: inject('redisPort') },
    });
  });

  afterAll(async () => {
    await queue?.close();
    await app?.close();
    nock.cleanAll();
  });

  describe('a new order', () => {
    it('answers 202 with the order summary and enqueues it', async () => {
      const body = payload();

      const res = await post(body).expect(202);

      expect(res.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{24}$/),
        order_id: body.order_id,
        status: 'RECEIVED',
        currency: 'USD',
        total: 119.8,
        revision: 1,
        enrichment: null,
        failure: null,
      });
      const [job] = await jobsFor(body.idempotency_key);
      expect(job!.data).toMatchObject({ orderId: res.body.id });
      expect(await orders.countDocuments({ order_id: body.order_id })).toBe(1);
    });

    it('never echoes personal data nor the idempotency keys', async () => {
      const res = await post(payload()).expect(202);

      expect(JSON.stringify(res.body)).not.toMatch(
        /user@example\.com|Ana|key-/,
      );
    });

    it('with a currency the provider does not convert: 202, FAILED_ENRICHMENT, no job', async () => {
      const body = payload({ currency: 'ARS' });

      const res = await post(body).expect(202);

      expect(res.body).toMatchObject({
        status: 'FAILED_ENRICHMENT',
        failure: { reason: 'UNSUPPORTED_CURRENCY', retryable: false },
      });
      expect(await jobsFor(body.idempotency_key)).toHaveLength(0);
    });

    it('ignores fields it does not know (providers add fields over time)', async () => {
      await post(payload({ marketplace: 'acme', notes: 'gift' })).expect(202);
    });
  });

  describe('idempotency', () => {
    it('the same request again answers 200 with the same order and no second job', async () => {
      const body = payload();
      const first = await post(body).expect(202);

      const second = await post(body).expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(await orders.countDocuments({ order_id: body.order_id })).toBe(1);
      expect(await jobsFor(body.idempotency_key)).toHaveLength(1);
    });

    it('10 identical requests at once: one 202, nine 200, one order, one job', async () => {
      const body = payload();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => post(body)),
      );

      const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([
        200, 200, 200, 200, 200, 200, 200, 200, 200, 202,
      ]);
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      expect(await orders.countDocuments({ order_id: body.order_id })).toBe(1);
      expect(await jobsFor(body.idempotency_key)).toHaveLength(1);
    });

    it('same order_id with another key: 409 ORDER_ALREADY_EXISTS (policy=reject)', async () => {
      const body = payload();
      await post(body).expect(202);

      const res = await post({
        ...body,
        idempotency_key: `${body.idempotency_key}-b`,
      }).expect(409);

      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'ORDER_ALREADY_EXISTS',
      });
    });

    it('same key for another order_id: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const body = payload();
      await post(body).expect(202);

      const res = await post({
        ...body,
        order_id: `${body.order_id}-b`,
      }).expect(422);

      expect(res.body).toMatchObject({
        statusCode: 422,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });
  });

  describe('invalid payloads: 400 with every problem listed', () => {
    it.each([
      ['order_id missing', { order_id: undefined }, 'order_id'],
      [
        'idempotency_key missing',
        { idempotency_key: undefined },
        'idempotency_key',
      ],
      [
        'idempotency_key too long',
        { idempotency_key: 'k'.repeat(256) },
        'idempotency_key',
      ],
      ['no items', { items: [] }, 'items'],
      [
        'zero quantity',
        { items: [{ sku: 'A', qty: 0, unit_price: 1 }] },
        'items.0.qty',
      ],
      [
        'fractional quantity',
        { items: [{ sku: 'A', qty: 1.5, unit_price: 1 }] },
        'items.0.qty',
      ],
      [
        'negative price',
        { items: [{ sku: 'A', qty: 1, unit_price: -1 }] },
        'items.0.unit_price',
      ],
      [
        'item without sku',
        { items: [{ qty: 1, unit_price: 1 }] },
        'items.0.sku',
      ],
      ['currency not ISO 4217', { currency: 'dolar' }, 'currency'],
      [
        'invalid email',
        { customer: { email: 'nope', name: 'Ana' } },
        'customer.email',
      ],
      ['customer missing', { customer: undefined }, 'customer'],
    ])('%s', async (_case, overrides, field) => {
      const res = await post(payload(overrides)).expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'INVALID_PAYLOAD',
        request_id: res.headers['x-request-id'],
      });
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        field,
      );
    });

    it('lists all the problems at once, not only the first', async () => {
      const res = await post(payload({ currency: 'dolar', items: [] })).expect(
        400,
      );

      const fields = res.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toEqual(expect.arrayContaining(['currency', 'items']));
    });

    it('a body that is not JSON', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/orders')
        .set('content-type', 'application/json')
        .send('{"order_id": ')
        .expect(400);

      expect(res.body).toMatchObject({
        code: 'MALFORMED_JSON',
        request_id: expect.any(String),
      });
    });
  });

  describe('request limits and correlation', () => {
    it('refuses a body over BODY_LIMIT with 413', async () => {
      const res = await post(payload({ notes: 'x'.repeat(4 * 1024) })).expect(
        413,
      );

      expect(res.body).toMatchObject({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        request_id: expect.any(String),
      });
    });

    it('generates a request id when the caller sends none', async () => {
      const res = await post(payload()).expect(202);

      expect(res.headers['x-request-id']).toMatch(/^req_/);
    });

    it("reuses the caller's x-request-id, so both sides can correlate", async () => {
      const res = await post(payload())
        .set('x-request-id', 'partner-abc-123')
        .expect(202);

      expect(res.headers['x-request-id']).toBe('partner-abc-123');
    });
  });
});
