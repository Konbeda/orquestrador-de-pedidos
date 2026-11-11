import type { INestApplication } from '@nestjs/common';
import nock from 'nock';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

/**
 * The OpenAPI document must describe what the API really answers: every status
 * code the e2e tests exercise is declared here, so docs and behavior cannot drift.
 */
describe('OpenAPI document (GET /docs-json)', () => {
  let app: INestApplication;
  let doc: {
    paths: Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    components: {
      schemas: Record<
        string,
        { required?: string[]; properties?: Record<string, unknown> }
      >;
    };
  };

  beforeAll(async () => {
    nock('https://frankfurter.test')
      .get('/v1/currencies')
      .reply(200, { USD: 'Dollar' })
      .persist();
    app = await createTestApp({
      FRANKFURTER_BASE_URL: 'https://frankfurter.test/v1',
      WORKER_ENABLED: 'false',
    });
    doc = (await request(app.getHttpServer()).get('/docs-json').expect(200))
      .body;
  });

  afterAll(async () => {
    await app?.close();
    nock.cleanAll();
  });

  it.each([
    ['/webhooks/orders', 'post', ['200', '202', '400', '409', '413', '422']],
    ['/orders', 'get', ['200', '400']],
    ['/orders/{id}', 'get', ['200', '404']],
    ['/orders/reprocess', 'post', ['202', '400']],
    ['/queue/metrics', 'get', ['200', '503']],
    ['/webhooks/rejections', 'get', ['200', '400']],
    ['/health', 'get', ['200', '503']],
  ])('%s %s declares %j', (path, method, statuses) => {
    const operation = doc.paths[path]?.[method];

    expect(
      operation,
      `${method.toUpperCase()} ${path} is documented`,
    ).toBeDefined();
    expect(Object.keys(operation!.responses).sort()).toEqual(
      expect.arrayContaining(statuses),
    );
  });

  it('documents the webhook body with its required fields', () => {
    const body = doc.components.schemas['ReceiveOrderDto']!;

    expect(body.required).toEqual(
      expect.arrayContaining([
        'order_id',
        'customer',
        'items',
        'currency',
        'idempotency_key',
      ]),
    );
  });

  it('documents the error format shared by every endpoint', () => {
    expect(doc.components.schemas['ErrorResponse']!.required).toEqual(
      expect.arrayContaining(['statusCode', 'code', 'message', 'request_id']),
    );
  });

  it('documents the order as answered: no customer data, no idempotency keys', () => {
    const order = doc.components.schemas['OrderResponse']!;

    expect(Object.keys(order.properties!)).toEqual(
      expect.arrayContaining([
        'id',
        'order_id',
        'status',
        'total',
        'enrichment',
        'failure',
      ]),
    );
    expect(Object.keys(order.properties!)).not.toEqual(
      expect.arrayContaining(['customer']),
    );
    expect(Object.keys(order.properties!)).not.toContain('idempotency_keys');
  });
});
