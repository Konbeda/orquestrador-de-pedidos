import {
  ExchangeRateProvider,
  type ExchangeRate,
} from '../../src/orders/application/ports/exchange-rate.provider.js';

/** Answers from a rate table; can be told to fail or to report its circuit open. */
export class FakeExchangeRateProvider extends ExchangeRateProvider {
  readonly calls: Array<{ from: string; to: string }> = [];
  private failure: { error: Error; timesLeft: number } | null = null;
  private circuitOpen = false;
  /** Runs inside getRate, before answering: lets a test look at the world mid-call. */
  onCall?: () => void | Promise<void>;

  constructor(
    private readonly rates: Record<string, number> = {
      'USD->BRL': 5.5,
      'EUR->BRL': 6,
    },
    private readonly date = '2026-11-10',
  ) {
    super();
  }

  isAvailable(): boolean {
    return !this.circuitOpen;
  }

  async getRate(from: string, to: string): Promise<ExchangeRate> {
    this.calls.push({ from, to });
    await this.onCall?.();
    if (this.failure && this.failure.timesLeft > 0) {
      this.failure.timesLeft -= 1;
      throw this.failure.error;
    }
    const rate = this.rates[`${from}->${to}`];
    if (rate === undefined) throw new Error(`No fake rate for ${from}->${to}`);
    return { rate, date: this.date };
  }

  /** The next `times` calls throw `error`. */
  failWith(error: Error, times = Infinity): void {
    this.failure = { error, timesLeft: times };
  }

  openCircuit(): void {
    this.circuitOpen = true;
  }
}
