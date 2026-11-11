import { evaluateHealth, type HealthProbes } from './evaluate-health.js';

const healthy: HealthProbes = {
  mongo: true,
  redis: true,
  frankfurter: { circuit: 'closed', currenciesSource: 'provider' },
};

describe('evaluateHealth', () => {
  it('everything up: ok, 200', () => {
    expect(evaluateHealth(healthy)).toEqual({
      httpStatus: 200,
      body: {
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
      },
    });
  });

  it('Mongo down: down, 503 (orders cannot be stored)', () => {
    const result = evaluateHealth({ ...healthy, mongo: false });

    expect(result.httpStatus).toBe(503);
    expect(result.body.status).toBe('down');
    expect(result.body.checks.mongo).toEqual({ status: 'down' });
  });

  it('Redis down: degraded, still 200 (intake goes on, the sweeper enqueues later)', () => {
    const result = evaluateHealth({ ...healthy, redis: false });

    expect(result.httpStatus).toBe(200);
    expect(result.body.status).toBe('degraded');
    expect(result.body.checks.redis).toEqual({ status: 'down' });
  });

  it('circuit open: Frankfurter down, app degraded (enrichment waits)', () => {
    const result = evaluateHealth({
      ...healthy,
      frankfurter: { circuit: 'open', currenciesSource: 'provider' },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body.status).toBe('degraded');
    expect(result.body.checks.frankfurter).toMatchObject({
      status: 'down',
      circuit: 'open',
    });
  });

  it('circuit half-open: still degraded until a trial call closes it', () => {
    const result = evaluateHealth({
      ...healthy,
      frankfurter: { circuit: 'half_open', currenciesSource: 'provider' },
    });

    expect(result.body.checks.frankfurter.status).toBe('degraded');
    expect(result.body.status).toBe('degraded');
  });

  it('currencies from the fallback list: degraded, with a hint (wrong FRANKFURTER_BASE_URL looks like this)', () => {
    const result = evaluateHealth({
      ...healthy,
      frankfurter: { circuit: 'closed', currenciesSource: 'fallback' },
    });

    expect(result.body.status).toBe('degraded');
    expect(result.body.checks.frankfurter).toMatchObject({
      status: 'degraded',
      currencies_source: 'fallback',
      hint: expect.stringContaining('FRANKFURTER_BASE_URL'),
    });
  });

  it('Mongo down wins over anything degraded', () => {
    const result = evaluateHealth({
      mongo: false,
      redis: false,
      frankfurter: { circuit: 'open', currenciesSource: 'fallback' },
    });

    expect(result.body.status).toBe('down');
    expect(result.httpStatus).toBe(503);
  });
});
