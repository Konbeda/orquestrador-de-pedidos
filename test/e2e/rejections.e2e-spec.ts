import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import nock from 'nock';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

const FRANKFURTER = 'https://frankfurter.test';
const sha256 = (data: string) =>
  createHash('sha256').update(data).digest('hex');

let sequence = 0;
const valid = () => {
  sequence += 1;
  return {
    order_id: `rej-${sequence}-${Date.now()}`,
    customer: { email: 'user@example.com', name: 'Ana Souza' },
    items: [{ sku: 'ABC123', qty: 1, unit_price: 10 }],
    currency: 'USD',
    idempotency_key: `rej-key-${sequence}-${Date.now()}`,
  };
};

describe('Audit of refused webhooks (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  /** Sends raw text, so the test knows the exact bytes the server hashed. */
  const postRaw = (raw: string) =>
    http()
      .post('/webhooks/orders')
      .set('content-type', 'application/json')
      .send(raw);
  const auditOf = async (requestId: string) =>
    (
      await http()
        .get(`/webhooks/rejections?request_id=${requestId}`)
        .expect(200)
    ).body.data;

  beforeAll(async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', USD: 'Dollar' })
      .persist();
    app = await createTestApp({
      FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1`,
      WORKER_ENABLED: 'false',
      BODY_LIMIT: '2kb',
    });
  });

  afterAll(async () => {
    await app?.close();
    nock.cleanAll();
  });

  it('a 400 is recorded: masked contract fields, names of unknown fields, hash of the exact bytes', async () => {
    const raw =
      // Extra spaces: re-serializing the parsed JSON would give other bytes, another hash.
      JSON.stringify(
        {
          ...valid(),
          currency: 'dolar',
          notes: 'CPF 123.456.789-00',
          customer: {
            email: 'user@example.com',
            name: 'Ana Souza',
            phone: '+55 11 99999-0000',
          },
        },
        null,
        3,
      );

    const res = await postRaw(raw)
      .set('user-agent', 'partner-webhooks/2.1')
      .expect(400);
    const [audit] = await auditOf(res.body.request_id);

    expect(audit).toMatchObject({
      request_id: res.body.request_id,
      kind: 'INVALID_PAYLOAD',
      user_agent: 'partner-webhooks/2.1',
      source: expect.any(String),
      received_at: expect.any(String),
      errors: res.body.errors,
      error_codes: ['currency:isISO4217CurrencyCode'],
      unknown_fields: ['customer.phone', 'notes'],
      payload_hash: sha256(raw),
      payload_size: Buffer.byteLength(raw),
    });
    expect(audit.payload.customer).toEqual({
      email: 'u***@example.com',
      name: 'A*** S***',
    });
    expect(JSON.stringify(audit)).not.toMatch(
      /user@example\.com|Souza|99999|123\.456/,
    );
  });

  it('the 400 response does not leak internal rule names', async () => {
    const res = await postRaw(
      JSON.stringify({ ...valid(), currency: 'dolar' }),
    ).expect(400);

    expect(Object.keys(res.body.errors[0]).sort()).toEqual([
      'field',
      'message',
    ]);
  });

  it('a body that is not JSON is recorded with its hash only', async () => {
    const raw = '{"order_id": "x", "customer": {"email": "user@exa';

    const res = await postRaw(raw).expect(400);
    const [audit] = await auditOf(res.body.request_id);

    expect(audit).toMatchObject({
      kind: 'MALFORMED_JSON',
      payload: null,
      payload_hash: sha256(raw),
      error_codes: ['body:malformedJson'],
    });
    expect(JSON.stringify(audit)).not.toContain('user@exa');
  });

  it('a body over the limit is recorded without reading it', async () => {
    const raw = JSON.stringify({ ...valid(), notes: 'x'.repeat(4 * 1024) });

    const res = await postRaw(raw).expect(413);
    const [audit] = await auditOf(res.body.request_id);

    expect(audit).toMatchObject({
      kind: 'PAYLOAD_TOO_LARGE',
      payload: null,
      payload_hash: null,
      payload_size: Buffer.byteLength(raw),
    });
  });

  it.each([
    ['an accepted order (202)', () => valid(), 202],
    [
      'a business conflict (409), which is not a contract violation',
      () => null,
      409,
    ],
  ])('records nothing for %s', async (_case, build, status) => {
    let body = build();
    if (!body) {
      body = valid();
      await http().post('/webhooks/orders').send(body).expect(202);
      body = { ...body, idempotency_key: `${body.idempotency_key}-b` };
    }

    const res = await http().post('/webhooks/orders').send(body).expect(status);

    expect(await auditOf(res.headers['x-request-id'])).toEqual([]);
  });

  it('lists the rejections of a source within a period, newest first', async () => {
    const first = await postRaw(
      JSON.stringify({ ...valid(), items: [] }),
    ).expect(400);
    const second = await postRaw(
      JSON.stringify({ ...valid(), items: [] }),
    ).expect(400);
    const { source } = (await auditOf(first.body.request_id))[0];

    const res = await http()
      .get('/webhooks/rejections')
      .query({ source, from: new Date(Date.now() - 60_000).toISOString() })
      .expect(200);

    const ids = res.body.data.map((r: { request_id: string }) => r.request_id);
    expect(ids.indexOf(second.body.request_id)).toBeLessThan(
      ids.indexOf(first.body.request_id),
    );
  });

  it('audits only the webhook: a 400 on another route records nothing', async () => {
    const res = await http().get('/orders?limit=0').expect(400);

    expect(await auditOf(res.body.request_id)).toEqual([]);
  });

  it('refuses a query without request_id or source (it would scan everything)', async () => {
    const res = await http().get('/webhooks/rejections').expect(400);

    expect(res.body.code).toBe('INVALID_PAYLOAD');
  });
});
