import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import nock from 'nock';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

const FRANKFURTER = 'https://frankfurter.test';

describe('GET /health (e2e)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    nock.cleanAll();
  });

  it('everything reachable: 200 ok', async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', USD: 'Dollar' });
    app = await createTestApp({ FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1` });

    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({
      status: 'ok',
      checks: {
        mongo: { status: 'up' },
        redis: { status: 'up' },
        frankfurter: {
          status: 'up',
          circuit: 'closed',
          currencies_source: 'provider',
        },
      },
    });
  });

  it('Mongo unreachable: 503 down (no orders can be stored)', async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(200, { BRL: 'Real', USD: 'Dollar' });
    app = await createTestApp({ FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1` });
    await app.get<Connection>(getConnectionToken()).close();

    const res = await request(app.getHttpServer()).get('/health').expect(503);

    expect(res.body).toMatchObject({
      status: 'down',
      checks: { mongo: { status: 'down' } },
    });
  });

  it('booted while Frankfurter was unreachable (or a wrong base URL): 200 degraded, with a hint', async () => {
    nock(FRANKFURTER)
      .get('/v1/currencies')
      .reply(404, { status: 404, message: 'not found' });
    app = await createTestApp({ FRANKFURTER_BASE_URL: `${FRANKFURTER}/v1` });

    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.frankfurter).toMatchObject({
      status: 'degraded',
      currencies_source: 'fallback',
      hint: expect.stringContaining('FRANKFURTER_BASE_URL'),
    });
  });
});
