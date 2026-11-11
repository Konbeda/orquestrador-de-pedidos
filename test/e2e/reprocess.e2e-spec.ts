import type { INestApplication } from '@nestjs/common';
import nock from 'nock';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';
import { waitFor } from '../helpers/wait-for.js';

const FRANKFURTER = 'https://frankfurter.test';

let sequence = 0;
const payload = () => {
  sequence += 1;
  return {
    order_id: `reproc-${sequence}-${Date.now()}`,
    customer: { email: 'user@example.com', name: 'Ana' },
    items: [{ sku: 'ABC123', qty: 2, unit_price: 59.9 }],
    currency: 'USD',
    idempotency_key: `reproc-key-${sequence}-${Date.now()}`,
  };
};

describe('POST /orders/reprocess (e2e)', () => {
  let app: INestApplication;
  let frankfurterUp = false;
  const http = () => request(app.getHttpServer());

  const statusOf = async (id: string) =>
    (await http().get(`/orders/${id}`).expect(200)).body;
  const settled = (id: string, status: string) =>
    waitFor(
      () => statusOf(id),
      (order) => order.status === status,
      {
        description: `order ${id} to be ${status}`,
      },
    );
  /** An order that exhausted its retries while Frankfurter was down. */
  const failedOrder = async () => {
    frankfurterUp = false;
    const { body } = await http()
      .post('/webhooks/orders')
      .send(payload())
      .expect(202);
    await settled(body.id, 'FAILED_ENRICHMENT');
    return body.id as string;
  };

  beforeAll(async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', USD: 'Dollar' })
      .persist();
    nock(FRANKFURTER)
      .get('/v1/latest')
      .query(true)
      .reply(() =>
        frankfurterUp
          ? [
              200,
              {
                amount: 1,
                base: 'USD',
                date: '2026-11-11',
                rates: { BRL: 5.5 },
              },
            ]
          : [503, { message: 'unavailable' }],
      )
      .persist();
    app = await createTestApp({
      FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1`,
      WORKER_ENABLED: 'true',
      CIRCUIT_FAILURE_THRESHOLD: '1000',
    });
  });

  afterAll(async () => {
    await app?.close();
    nock.cleanAll();
  });

  it('Frankfurter is back: a failed order is reprocessed and ends up enriched', async () => {
    const id = await failedOrder();
    expect((await statusOf(id)).failure).toEqual({
      reason: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });

    frankfurterUp = true;
    const res = await http()
      .post('/orders/reprocess')
      .send({ order_ids: [id] })
      .expect(202);

    expect(res.body).toEqual({
      reprocessed: [{ id, pending_enqueue: false }],
      skipped: [],
    });
    expect(await settled(id, 'ENRICHED')).toMatchObject({
      enrichment: { converted_total: 658.9 },
      failure: null,
    });
  });

  it('explains why an order was not reprocessed', async () => {
    const id = await failedOrder();
    frankfurterUp = true;
    await http()
      .post('/orders/reprocess')
      .send({ order_ids: [id] })
      .expect(202);
    await settled(id, 'ENRICHED');

    const res = await http()
      .post('/orders/reprocess')
      .send({ order_ids: [id, '6af3e21ba882a0d0ffdfb82d'] })
      .expect(202);

    expect(res.body).toEqual({
      reprocessed: [],
      skipped: [
        { id, reason: 'NOT_FAILED' },
        { id: '6af3e21ba882a0d0ffdfb82d', reason: 'NOT_FOUND' },
      ],
    });
  });

  it('without ids, reprocesses the retryable failures in batch', async () => {
    const first = await failedOrder();
    const second = await failedOrder();
    frankfurterUp = true;

    const res = await http()
      .post('/orders/reprocess')
      .send({ limit: 500 })
      .expect(202);

    const ids = res.body.reprocessed.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([first, second]));
    await settled(first, 'ENRICHED');
    await settled(second, 'ENRICHED');
  });

  it.each([
    ['ids that are not order ids', { order_ids: ['nope'] }, 'order_ids'],
    [
      'too many ids',
      {
        order_ids: Array.from(
          { length: 101 },
          () => '6af3e21ba882a0d0ffdfb82d',
        ),
      },
      'order_ids',
    ],
    ['a limit out of range', { limit: 501 }, 'limit'],
  ])('400 for %s', async (_case, body, field) => {
    const res = await http().post('/orders/reprocess').send(body).expect(400);

    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
      field,
    );
  });
});
