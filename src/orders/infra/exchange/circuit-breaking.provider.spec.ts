import { FakeExchangeRateProvider } from '../../../../test/fakes/fake-exchange-rate.provider.js';
import {
  ProviderRejectedError,
  ProviderUnavailableError,
} from '../../application/ports/exchange-rate.provider.js';
import { CircuitBreakingExchangeRateProvider } from './circuit-breaking.provider.js';

describe('CircuitBreakingExchangeRateProvider', () => {
  let now: number;
  let inner: FakeExchangeRateProvider;
  let states: string[];

  const provider = () =>
    new CircuitBreakingExchangeRateProvider(inner, {
      failureThreshold: 2,
      resetTimeoutMs: 30_000,
      now: () => now,
      onStateChange: (state) => states.push(state),
    });
  const attempt = (p: CircuitBreakingExchangeRateProvider) =>
    p.getRate('USD', 'BRL').catch((error: unknown) => error);

  beforeEach(() => {
    now = 0;
    inner = new FakeExchangeRateProvider();
    states = [];
  });

  it('delegates to the wrapped provider while closed', async () => {
    await expect(provider().getRate('USD', 'BRL')).resolves.toEqual({
      rate: 5.5,
      date: '2026-11-10',
    });
  });

  it('opens after consecutive outages and reports itself unavailable', async () => {
    const p = provider();
    inner.failWith(new ProviderUnavailableError('503'));

    await attempt(p);
    await attempt(p);

    expect(p.isAvailable()).toBe(false);
    expect(states).toEqual(['open']);
  });

  it('does not open on rejected requests: a 4xx means Frankfurter is answering', async () => {
    const p = provider();
    inner.failWith(new ProviderRejectedError('404'));

    await attempt(p);
    await attempt(p);
    await attempt(p);

    expect(p.isAvailable()).toBe(true);
  });

  it('while open, fails as a temporary error without calling Frankfurter', async () => {
    const p = provider();
    inner.failWith(new ProviderUnavailableError('503'));
    await attempt(p);
    await attempt(p);
    inner.calls.length = 0;

    const error = await attempt(p);

    // Temporary, so a worker that raced the circuit opening retries instead of failing the order.
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(inner.calls).toHaveLength(0);
  });

  it('closes again after a successful trial once the reset timeout passes', async () => {
    const p = provider();
    inner.failWith(new ProviderUnavailableError('503'), 2);
    await attempt(p);
    await attempt(p);

    now = 30_000;
    await p.getRate('USD', 'BRL');

    expect(p.isAvailable()).toBe(true);
    expect(states).toEqual(['open', 'half_open', 'closed']);
  });

  it('exposes the circuit state for the health check', async () => {
    const p = provider();
    expect(p.circuitState).toBe('closed');
    inner.failWith(new ProviderUnavailableError('503'));

    await attempt(p);
    await attempt(p);

    expect(p.circuitState).toBe('open');
  });
});
