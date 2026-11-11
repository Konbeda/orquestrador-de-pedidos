import {
  ExchangeRateProvider,
  ProviderUnavailableError,
  type ExchangeRate,
} from '../../application/ports/exchange-rate.provider.js';
import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitBreakerOptions,
  type CircuitState,
} from '../../../shared/resilience/circuit-breaker.js';

export type CircuitBreakingSettings = Omit<CircuitBreakerOptions, 'isFailure'>;

/**
 * Decorator: puts a circuit breaker in front of any exchange rate provider.
 *
 * Only outages (ProviderUnavailableError) count: a rejected request proves the
 * provider is up. While open, calls fail as ProviderUnavailableError (temporary),
 * so a worker that raced the circuit opening retries instead of failing the order;
 * EnrichOrder checks isAvailable() first, so most jobs never get that far.
 */
export class CircuitBreakingExchangeRateProvider extends ExchangeRateProvider {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly inner: ExchangeRateProvider,
    settings: CircuitBreakingSettings,
  ) {
    super();
    this.breaker = new CircuitBreaker({
      ...settings,
      isFailure: (error) => error instanceof ProviderUnavailableError,
    });
  }

  isAvailable(): boolean {
    return this.breaker.isAvailable();
  }

  /** For the health check. */
  get circuitState(): CircuitState {
    return this.breaker.state;
  }

  async getRate(from: string, to: string): Promise<ExchangeRate> {
    try {
      return await this.breaker.execute(() => this.inner.getRate(from, to));
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new ProviderUnavailableError(error.message, { cause: error });
      }
      throw error;
    }
  }
}
