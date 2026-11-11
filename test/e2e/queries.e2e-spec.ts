import type { INestApplication } from '@nestjs/common';
import nock from 'nock';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

const FRANKFURTER = 'https://frankfurter.test';

let sequence = 0;
const payload = (overrides: Record<string, unknown> = {}) => {
  sequence += 1;
  return {
    order_id: `query-${sequence}-${Date.now()}`,
    customer: { email: 'user@example.com', name: 'Ana' },
    items: [{ sku: 'ABC123', qty: 1, unit_price: 10 }],
    currency: 'USD',
    idempotency_key: `query-key-${sequence}-${Date.now()}`,
    ...overrides,
  };
};

describe('Queries: GET /orders, GET /orders/:id, GET /queue/metrics (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const receive = async (overrides: Record<string, unknown> = {}) =>
    (await http().post('/webhooks/orders').send(payload(overrides)).expect(202))
      .body;

  beforeAll(async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', USD: 'Dollar' })
      .persist();
    app = await createTestApp({
      FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1`,
      WORKER_ENABLED: 'false', // jobs stay waiting: metrics are predictable
    });
  });

  afterAll(async () => {
    await app?.close();
    nock.cleanAll();
  });

  describe('GET /orders/:id', () => {
    it('returns the order in the same shape as the webhook answer', async () => {
      const created = await receive();

      const res = await http().get(`/orders/${created.id}`).expect(200);

      expect(res.body).toEqual(created);
    });

    it.each(['6af3e21ba882a0d0ffdfb82d', 'not-an-id'])(
      '404 ORDER_NOT_FOUND for an id that does not exist (%s)',
      async (id) => {
        const res = await http().get(`/orders/${id}`).expect(404);

        expect(res.body).toMatchObject({
          code: 'ORDER_NOT_FOUND',
          request_id: expect.any(String),
        });
      },
    );
  });

  describe('GET /orders', () => {
    it('lists newest first and pages with next_cursor', async () => {
      const a = await receive();
      const b = await receive();
      const c = await receive();

      const first = await http().get('/orders?limit=2').expect(200);
      expect(first.body.data.map((o: { id: string }) => o.id)).toEqual([
        c.id,
        b.id,
      ]);
      expect(first.body.next_cursor).toBe(b.id);

      const second = await http()
        .get(`/orders?limit=2&cursor=${b.id}`)
        .expect(200);
      expect(second.body.data[0].id).toBe(a.id);
    });

    it('next_cursor is null on the last page', async () => {
      const only = await receive();

      const res = await http()
        .get(`/orders?order_id=${only.order_id}`)
        .expect(200);

      expect(res.body).toEqual({ data: [only], next_cursor: null });
    });

    it('filters by status', async () => {
      const failed = await receive({ currency: 'ARS' }); // unsupported → FAILED_ENRICHMENT

      const res = await http()
        .get('/orders?status=FAILED_ENRICHMENT&limit=100')
        .expect(200);

      expect(res.body.data.map((o: { id: string }) => o.id)).toContain(
        failed.id,
      );
      expect(
        res.body.data.every(
          (o: { status: string }) => o.status === 'FAILED_ENRICHMENT',
        ),
      ).toBe(true);
    });

    it('never exposes customer data in the list either', async () => {
      await receive();

      const res = await http().get('/orders?limit=5').expect(200);

      expect(JSON.stringify(res.body)).not.toMatch(
        /user@example\.com|Ana|query-key-/,
      );
    });

    it.each([
      ['status=NOPE', 'status'],
      ['limit=0', 'limit'],
      ['limit=101', 'limit'],
      ['limit=abc', 'limit'],
      ['cursor=not-an-id', 'cursor'],
    ])('400 for an invalid query (%s)', async (query, field) => {
      const res = await http().get(`/orders?${query}`).expect(400);

      expect(res.body.code).toBe('INVALID_PAYLOAD');
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        field,
      );
    });
  });

  describe('GET /queue/metrics', () => {
    it('reports job counts per state, the circuit pause and the dead letter total', async () => {
      const before = (await http().get('/queue/metrics').expect(200)).body;

      expect(before).toEqual({
        enrichment: {
          waiting: expect.any(Number),
          active: expect.any(Number),
          delayed: expect.any(Number),
          completed: expect.any(Number),
          failed: expect.any(Number),
          paused_for_ms: expect.any(Number),
        },
        dead_letter: { total: expect.any(Number) },
      });

      // No open circuit here: no pause (BullMQ answers -2 for "no key").
      expect(before.enrichment.paused_for_ms).toBe(0);

      await receive();
      const after = (await http().get('/queue/metrics').expect(200)).body;

      // No worker in this app: the new job is still waiting.
      expect(after.enrichment.waiting).toBe(before.enrichment.waiting + 1);
    });
  });
});
