import {
  ExchangeRateProvider,
  ProviderRejectedError,
  ProviderUnavailableError,
  type ExchangeRate,
} from '../../application/ports/exchange-rate.provider.js';

export interface FrankfurterSettings {
  /** e.g. https://api.frankfurter.dev/v1 */
  baseUrl: string;
  timeoutMs: number;
}

/** 4xx that are about timing, not about the request: retrying later can work. */
const TEMPORARY_CLIENT_ERRORS = new Set([408, 429]);

/**
 * HTTP client for Frankfurter (free exchange rates, no API key).
 *
 * Error mapping, checked against the live API:
 *   404 unknown/unsupported currency, 422 same currency, 400  → ProviderRejectedError
 *   408, 429, 5xx, timeout, network error, unexpected body     → ProviderUnavailableError
 *
 * Caveat: a wrong FRANKFURTER_BASE_URL also answers 404, which would look like
 * "currency rejected". The boot check of /currencies exposes that misconfiguration.
 */
export class FrankfurterClient extends ExchangeRateProvider {
  private readonly baseUrl: string;

  constructor(private readonly settings: FrankfurterSettings) {
    super();
    this.baseUrl = settings.baseUrl.replace(/\/+$/, '');
  }

  /** The raw client has no circuit; see CircuitBreakingExchangeRateProvider. */
  isAvailable(): boolean {
    return true;
  }

  async getRate(from: string, to: string): Promise<ExchangeRate> {
    const query = new URLSearchParams({ base: from, symbols: to });
    const body = await this.get(`/latest?${query}`);

    const rate = (body as { rates?: Record<string, unknown> })?.rates?.[to];
    const date = (body as { date?: unknown })?.date;
    if (
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      typeof date !== 'string'
    ) {
      throw new ProviderUnavailableError(
        `Unexpected response for ${from}->${to}`,
      );
    }
    return { rate, date };
  }

  async listCurrencies(): Promise<string[]> {
    const body = await this.get('/currencies');
    if (!body || typeof body !== 'object') {
      throw new ProviderUnavailableError('Unexpected /currencies response');
    }
    return Object.keys(body).sort();
  }

  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (error) {
      // Timeout (AbortSignal), DNS, connection refused/reset.
      throw new ProviderUnavailableError(
        `Frankfurter unreachable: ${describe(error)}`,
        {
          cause: error,
        },
      );
    }

    if (!response.ok) {
      const message = `Frankfurter answered ${response.status} for ${path}`;
      const temporary =
        response.status >= 500 || TEMPORARY_CLIENT_ERRORS.has(response.status);
      throw temporary
        ? new ProviderUnavailableError(message)
        : new ProviderRejectedError(message);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new ProviderUnavailableError(
        `Frankfurter sent a body that is not JSON`,
        {
          cause: error,
        },
      );
    }
  }
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
