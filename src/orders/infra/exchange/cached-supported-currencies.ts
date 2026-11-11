import { SupportedCurrencies } from '../../application/ports/supported-currencies.js';

export interface CurrencySource {
  listCurrencies(): Promise<string[]>;
}

export interface CachedSupportedCurrenciesSettings {
  /** How long a list from the provider is trusted. */
  ttlMs: number;
  /** After a failed load, how long to wait before asking the provider again. */
  retryAfterFailureMs: number;
  /** Used only when the provider never answered since boot. */
  fallback: string[];
  now?: () => number;
}

/**
 * Which currencies the exchange provider converts, asked at most once per TTL.
 *
 * When the provider is down: the last list it gave wins over the configured
 * fallback (stale but real beats guessed); the fallback covers a boot without it.
 */
export class CachedSupportedCurrencies extends SupportedCurrencies {
  private codes: Set<string> | null = null;
  private fromProvider = false;
  private validUntil = 0;
  private loading: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly source: CurrencySource,
    private readonly settings: CachedSupportedCurrenciesSettings,
  ) {
    super();
    this.now = settings.now ?? Date.now;
  }

  async isSupported(currency: string): Promise<boolean> {
    if (this.now() >= this.validUntil) await this.refresh();
    return this.codes!.has(currency.trim().toUpperCase());
  }

  /** Called at boot, so the first webhook does not pay for the request. */
  async warmUp(): Promise<'provider' | 'fallback'> {
    await this.refresh();
    return this.fromProvider ? 'provider' : 'fallback';
  }

  /** Concurrent callers share the same in-flight request. */
  private refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const codes = await this.source.listCurrencies();
      this.codes = new Set(codes.map((code) => code.toUpperCase()));
      this.fromProvider = true;
      this.validUntil = this.now() + this.settings.ttlMs;
    } catch {
      if (!this.fromProvider) {
        this.codes = new Set(
          this.settings.fallback.map((code) => code.toUpperCase()),
        );
      }
      this.validUntil = this.now() + this.settings.retryAfterFailureMs;
    }
  }
}
