import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import type { Connection } from 'mongoose';
import nock from 'nock';
import request from 'supertest';
import { inject } from 'vitest';
import { DEAD_LETTER_QUEUE_NAME } from '../../src/orders/infra/queue/enrichment.worker.js';
import { createTestApp } from '../helpers/test-app.js';
import { waitFor } from '../helpers/wait-for.js';

const FRANKFURTER = 'https://frankfurter.test';

let sequence = 0;
const payload = (currency: string) => {
  sequence += 1;
  return {
    order_id: `enrich-${sequence}-${Date.now()}`,
    customer: { email: 'user@example.com', name: 'Ana' },
    items: [{ sku: 'ABC123', qty: 2, unit_price: 59.9 }], // 119.80
    currency,
    idempotency_key: `enrich-key-${sequence}-${Date.now()}`,
  };
};

describe('Webhook → queue → worker → Frankfurter → order (e2e)', () => {
  let app: INestApplication;
  let deadLetters: Queue;
  let orders: ReturnType<Connection['collection']>;

  const receive = async (currency: string) => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/orders')
      .send(payload(currency))
      .expect(202);
    return res.body.id as string;
  };
  const orderOnceItSettles = (orderId: string) =>
    waitFor(
      () => orders.findOne({ order_id: orderId }),
      (doc) =>
        doc?.status === 'ENRICHED' || doc?.status === 'FAILED_ENRICHMENT',
      { description: `order ${orderId} to settle` },
    );

  beforeAll(async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', EUR: 'Euro', USD: 'Dollar' })
      .persist();
    nock(FRANKFURTER)
      .get('/v1/latest')
      .query({ base: 'USD', symbols: 'BRL' })
      .reply(200, {
        amount: 1,
        base: 'USD',
        date: '2026-11-10',
        rates: { BRL: 5.5 },
      })
      .persist();
    nock(FRANKFURTER)
      .get('/v1/latest')
      .query({ base: 'EUR', symbols: 'BRL' })
      .reply(503, { message: 'unavailable' })
      .persist();

    app = await createTestApp({
      FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1`,
      WORKER_ENABLED: 'true',
      // This file is about retries and the DLQ; the circuit has its own e2e.
      CIRCUIT_FAILURE_THRESHOLD: '1000',
    });
    orders = app.get<Connection>(getConnectionToken()).collection('orders');
    deadLetters = new Queue(DEAD_LETTER_QUEUE_NAME, {
      connection: { host: inject('redisHost'), port: inject('redisPort') },
    });
  });

  afterAll(async () => {
    await deadLetters?.close();
    await app?.close();
    nock.cleanAll();
  });

  it('enriches the order with the converted total', async () => {
    const id = await receive('USD');
    const { order_id } = (await orders.findOne({}, { sort: { _id: -1 } }))!;

    const settled = await orderOnceItSettles(order_id);

    expect(settled!._id.toHexString()).toBe(id);
    expect(settled).toMatchObject({
      status: 'ENRICHED',
      failure: null,
      enrichment: {
        target_currency: 'BRL',
        rate: 5.5,
        rate_date: '2026-11-10',
        converted_total: 658.9,
      },
    });
  });

  it('an order already in the target currency is enriched without calling Frankfurter', async () => {
    await receive('BRL'); // no nock for BRL->BRL: a call would fail the order
    const { order_id } = (await orders.findOne({}, { sort: { _id: -1 } }))!;

    expect(await orderOnceItSettles(order_id)).toMatchObject({
      status: 'ENRICHED',
      enrichment: { rate: 1, converted_total: 119.8 },
    });
  });

  it('Frankfurter failing on every retry: FAILED_ENRICHMENT, retryable, and a copy in the DLQ', async () => {
    const id = await receive('EUR');
    const { order_id } = (await orders.findOne({}, { sort: { _id: -1 } }))!;

    expect(await orderOnceItSettles(order_id)).toMatchObject({
      status: 'FAILED_ENRICHMENT',
      failure: { reason: 'PROVIDER_UNAVAILABLE', retryable: true },
    });
    const dead = await waitFor(
      () => deadLetters.getJobs(['waiting']),
      (jobs) => jobs.some((job) => job.data.orderId === id),
      { description: 'dead letter' },
    );
    expect(dead.find((job) => job.data.orderId === id)!.data).toMatchObject({
      reason: 'PROVIDER_UNAVAILABLE',
      attempts: 3, // ENRICHMENT_MAX_ATTEMPTS in the test app
    });

    const metrics = await request(app.getHttpServer())
      .get('/queue/metrics')
      .expect(200);
    expect(metrics.body.dead_letter.total).toBeGreaterThanOrEqual(1);
    expect(metrics.body.enrichment.failed).toBeGreaterThanOrEqual(1);
  });
});
