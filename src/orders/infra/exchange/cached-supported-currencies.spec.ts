import type { Mock } from 'vitest';
import { ProviderUnavailableError } from '../../application/ports/exchange-rate.provider.js';
import { CachedSupportedCurrencies } from './cached-supported-currencies.js';

const HOUR = 60 * 60 * 1000;

describe('CachedSupportedCurrencies', () => {
  let now: number;
  let source: { listCurrencies: Mock<() => Promise<string[]>> };

  const currencies = () =>
    new CachedSupportedCurrencies(source, {
      ttlMs: 6 * HOUR,
      retryAfterFailureMs: 60_000,
      fallback: ['USD', 'BRL'],
      now: () => now,
    });

  beforeEach(() => {
    now = 0;
    source = {
      listCurrencies: vi.fn<() => Promise<string[]>>(async () => [
        'BRL',
        'EUR',
        'USD',
      ]),
    };
  });

  it('answers from the list the provider publishes', async () => {
    const c = currencies();

    expect(await c.isSupported('EUR')).toBe(true);
    expect(await c.isSupported('ARS')).toBe(false);
  });

  it('is case insensitive', async () => {
    expect(await currencies().isSupported('eur')).toBe(true);
  });

  it('asks the provider once per TTL', async () => {
    const c = currencies();
    await c.isSupported('EUR');
    now = 6 * HOUR - 1;
    await c.isSupported('EUR');
    expect(source.listCurrencies).toHaveBeenCalledTimes(1);

    now = 6 * HOUR;
    await c.isSupported('EUR');

    expect(source.listCurrencies).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    const c = currencies();

    await Promise.all([
      c.isSupported('EUR'),
      c.isSupported('USD'),
      c.isSupported('BRL'),
    ]);

    expect(source.listCurrencies).toHaveBeenCalledTimes(1);
  });

  it('uses the configured fallback when the provider never answered', async () => {
    source.listCurrencies.mockRejectedValue(
      new ProviderUnavailableError('down'),
    );
    const c = currencies();

    expect(await c.isSupported('USD')).toBe(true);
    expect(await c.isSupported('EUR')).toBe(false);
  });

  it('keeps the last good list when the provider fails later (stale beats fallback)', async () => {
    const c = currencies();
    await c.isSupported('EUR');
    source.listCurrencies.mockRejectedValue(
      new ProviderUnavailableError('down'),
    );
    now = 6 * HOUR;

    expect(await c.isSupported('EUR')).toBe(true);
  });

  it('after a failure, waits before asking again instead of calling on every request', async () => {
    source.listCurrencies.mockRejectedValue(
      new ProviderUnavailableError('down'),
    );
    const c = currencies();
    await c.isSupported('USD');
    now = 59_999;
    await c.isSupported('USD');
    expect(source.listCurrencies).toHaveBeenCalledTimes(1);

    source.listCurrencies.mockResolvedValue(['BRL', 'EUR', 'USD']);
    now = 60_000;

    expect(await c.isSupported('EUR')).toBe(true);
    expect(source.listCurrencies).toHaveBeenCalledTimes(2);
  });

  it('warmUp loads at boot and says where the list came from', async () => {
    expect(await currencies().warmUp()).toBe('provider');

    source.listCurrencies.mockRejectedValue(
      new ProviderUnavailableError('down'),
    );
    expect(await currencies().warmUp()).toBe('fallback');
  });
});
