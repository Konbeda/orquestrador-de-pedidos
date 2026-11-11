import { validateEnv } from './env.schema.js';

const minimalEnv = {
  MONGO_URI: 'mongodb://localhost:27017/orders',
  REDIS_HOST: 'localhost',
};

describe('validateEnv', () => {
  it('applies safe defaults when only the required variables are set', () => {
    const env = validateEnv(minimalEnv);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      REDIS_PORT: 6379,
      ORDER_DUPLICATE_POLICY: 'reject',
      ENRICHMENT_TARGET_CURRENCY: 'BRL',
      ENRICHMENT_MAX_ATTEMPTS: 5,
      REJECTION_RETENTION_DAYS: 90,
      REPROCESS_MAX_COUNT: 3,
      MAX_ORDER_REVISIONS: 10,
      SWEEP_INTERVAL_MS: 60_000,
      STALE_ORDER_AFTER_MS: 120_000,
      SWEEP_BATCH_SIZE: 100,
    });
  });

  it('coerces numeric variables from strings', () => {
    const env = validateEnv({
      ...minimalEnv,
      PORT: '8080',
      ENRICHMENT_BACKOFF_MS: '250',
    });

    expect(env.PORT).toBe(8080);
    expect(env.ENRICHMENT_BACKOFF_MS).toBe(250);
  });

  it('parses the fallback currency list into uppercase codes', () => {
    const env = validateEnv({
      ...minimalEnv,
      SUPPORTED_CURRENCIES_FALLBACK: 'usd, eur ,brl',
    });

    expect(env.SUPPORTED_CURRENCIES_FALLBACK).toEqual(['USD', 'EUR', 'BRL']);
  });

  it('accepts the update duplicate policy', () => {
    expect(
      validateEnv({ ...minimalEnv, ORDER_DUPLICATE_POLICY: 'update' })
        .ORDER_DUPLICATE_POLICY,
    ).toBe('update');
  });

  it('refuses to start with an unknown duplicate policy', () => {
    expect(() =>
      validateEnv({ ...minimalEnv, ORDER_DUPLICATE_POLICY: 'merge' }),
    ).toThrow(/ORDER_DUPLICATE_POLICY/);
  });

  it('refuses to start without the required connection settings', () => {
    expect(() => validateEnv({})).toThrow(
      /MONGO_URI[\s\S]*REDIS_HOST|REDIS_HOST[\s\S]*MONGO_URI/,
    );
  });

  it('refuses a non ISO 4217 target currency', () => {
    expect(() =>
      validateEnv({ ...minimalEnv, ENRICHMENT_TARGET_CURRENCY: 'real' }),
    ).toThrow(/ENRICHMENT_TARGET_CURRENCY/);
  });

  it('parses the in-request enqueue retry delays, defaulting to 100, 200, 400 ms', () => {
    expect(validateEnv(minimalEnv).ENQUEUE_RETRY_DELAYS_MS).toEqual([
      100, 200, 400,
    ]);
    expect(
      validateEnv({ ...minimalEnv, ENQUEUE_RETRY_DELAYS_MS: '50, 50' })
        .ENQUEUE_RETRY_DELAYS_MS,
    ).toEqual([50, 50]);
  });

  it('accepts an empty retry list, meaning a single enqueue attempt', () => {
    expect(
      validateEnv({ ...minimalEnv, ENQUEUE_RETRY_DELAYS_MS: '' })
        .ENQUEUE_RETRY_DELAYS_MS,
    ).toEqual([]);
  });

  it('refuses a non numeric retry delay', () => {
    expect(() =>
      validateEnv({ ...minimalEnv, ENQUEUE_RETRY_DELAYS_MS: '100,abc' }),
    ).toThrow(/ENQUEUE_RETRY_DELAYS_MS/);
  });

  it('refuses zero attempts, since a job must run at least once', () => {
    expect(() =>
      validateEnv({ ...minimalEnv, ENRICHMENT_MAX_ATTEMPTS: '0' }),
    ).toThrow(/ENRICHMENT_MAX_ATTEMPTS/);
  });
});
