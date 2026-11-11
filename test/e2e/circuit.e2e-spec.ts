import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import type { Connection } from 'mongoose';
import nock from 'nock';
import request from 'supertest';
import { inject } from 'vitest';
import { ENRICHMENT_QUEUE_NAME } from '../../src/orders/infra/queue/bullmq-enrichment.queue.js';
import { createTestApp } from '../helpers/test-app.js';
import { waitFor } from '../helpers/wait-for.js';

const FRANKFURTER = 'https://frankfurter.test';

describe('Frankfurter down: the circuit opens and the queue holds (e2e)', () => {
  let app: INestApplication;
  let queue: Queue;
  let orders: ReturnType<Connection['collection']>;
  let rateCalls = 0;

  const receive = (n: number) =>
    request(app.getHttpServer())
      .post('/webhooks/orders')
      .send({
        order_id: `circuit-${n}-${Date.now()}`,
        customer: { email: 'user@example.com', name: 'Ana' },
        items: [{ sku: 'ABC123', qty: 1, unit_price: 10 }],
        currency: 'USD',
        idempotency_key: `circuit-key-${n}-${Date.now()}`,
      })
      .expect(202);

  beforeAll(async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', USD: 'Dollar' })
      .persist();
    nock(FRANKFURTER)
      .get('/v1/latest')
      .query(true)
      .reply(() => {
        rateCalls += 1;
        return [503, { message: 'unavailable' }];
      })
      .persist();

    app = await createTestApp({
      FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1`,
      WORKER_ENABLED: 'true',
      CIRCUIT_FAILURE_THRESHOLD: '2',
      CIRCUIT_RESET_TIMEOUT_MS: '60000',
      ENRICHMENT_MAX_ATTEMPTS: '5',
    });
    orders = app.get<Connection>(getConnectionToken()).collection('orders');
    queue = new Queue(ENRICHMENT_QUEUE_NAME, {
      connection: { host: inject('redisHost'), port: inject('redisPort') },
    });
  });

  afterAll(async () => {
    await app?.close();
    // Leave no pause behind for the next test files.
    await queue?.removeRateLimitKey();
    await queue?.obliterate({ force: true });
    await queue?.close();
    nock.cleanAll();
  });

  it('stops calling Frankfurter after the threshold; new orders wait as RECEIVED, no attempts spent', async () => {
    const first = await receive(1);

    // 2 failures open the circuit; the next attempt finds it open and pauses the queue.
    await waitFor(async () => (await queue.getRateLimitTtl()) > 0, Boolean, {
      description: 'queue paused by the open circuit',
    });
    expect(rateCalls).toBe(2);

    const second = await receive(2);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(rateCalls).toBe(2);
    expect(
      await orders.findOne({ order_id: second.body.order_id }),
    ).toMatchObject({
      status: 'RECEIVED',
    });
    // The first order is not failed: its job waits for the circuit like the others.
    expect(
      (await orders.findOne({ order_id: first.body.order_id }))!.status,
    ).not.toBe('FAILED_ENRICHMENT');
  });
});
