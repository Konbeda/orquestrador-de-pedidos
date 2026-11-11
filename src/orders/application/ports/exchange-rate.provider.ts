export interface ExchangeRate {
  rate: number;
  /** Date of the rate as published by the provider (YYYY-MM-DD). */
  date: string;
}

/** Temporary: timeout, 5xx, connection refused, circuit opened mid-call. Retrying may work. */
export class ProviderUnavailableError extends Error {
  override name = 'ProviderUnavailableError';
}

/** Permanent: the provider refused this request (4xx). The same request will never work. */
export class ProviderRejectedError extends Error {
  override name = 'ProviderRejectedError';
}

export abstract class ExchangeRateProvider {
  /**
   * False while calls are known to be pointless (circuit open). No network round trip.
   * An optimization only: true does not guarantee the next call succeeds.
   */
  abstract isAvailable(): boolean;

  abstract getRate(from: string, to: string): Promise<ExchangeRate>;
}
