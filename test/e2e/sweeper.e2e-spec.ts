import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import nock from 'nock';
import { createTestApp } from '../helpers/test-app.js';
import { waitFor } from '../helpers/wait-for.js';

const FRANKFURTER = 'https://frankfurter.test';
const HOUR = 60 * 60 * 1000;

describe('Orphan sweeper (e2e)', () => {
  let app: INestApplication;
  let orders: ReturnType<Connection['collection']>;

  beforeAll(async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', USD: 'Dollar' })
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

    app = await createTestApp({
      FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1`,
      WORKER_ENABLED: 'true',
      SWEEP_INTERVAL_MS: '200',
      STALE_ORDER_AFTER_MS: '1000',
    });
    orders = app.get<Connection>(getConnectionToken()).collection('orders');
  });

  afterAll(async () => {
    await app?.close();
    nock.cleanAll();
  });

  it('an order stored without a job (enqueue failed, client never retried) ends up enriched', async () => {
    // Exactly what a webhook leaves behind when Redis fails after the insert.
    await orders.insertOne({
      order_id: 'orphan-1',
      idempotency_keys: ['orphan-key-1'],
      customer: { email: 'user@example.com', name: 'Ana' },
      items: [{ sku: 'ABC123', qty: 2, unit_price: 59.9 }],
      currency: 'USD',
      total: 119.8,
      status: 'RECEIVED',
      enrichment: null,
      failure: null,
      revision: 1,
      reprocess_count: 0,
      queue_checked_at: new Date(Date.now() - HOUR),
      created_at: new Date(Date.now() - HOUR),
      updated_at: new Date(Date.now() - HOUR),
    });

    const settled = await waitFor(
      () => orders.findOne({ order_id: 'orphan-1' }),
      (doc) => doc?.status === 'ENRICHED',
      { timeoutMs: 15_000, description: 'orphan to be swept and enriched' },
    );

    expect(settled!.enrichment).toMatchObject({ converted_total: 658.9 });
  });

  it('leaves a recent RECEIVED order alone (it may simply be waiting in the queue)', async () => {
    await orders.insertOne({
      order_id: 'fresh-1',
      idempotency_keys: ['fresh-key-1'],
      customer: { email: 'user@example.com', name: 'Ana' },
      items: [{ sku: 'ABC123', qty: 1, unit_price: 10 }],
      currency: 'USD',
      total: 10,
      status: 'RECEIVED',
      enrichment: null,
      failure: null,
      revision: 1,
      reprocess_count: 0,
      queue_checked_at: new Date(Date.now() + HOUR), // far from stale
      created_at: new Date(),
      updated_at: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect((await orders.findOne({ order_id: 'fresh-1' }))!.status).toBe(
      'RECEIVED',
    );
  });
});
