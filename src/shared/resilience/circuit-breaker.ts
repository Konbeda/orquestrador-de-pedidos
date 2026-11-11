export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before letting a trial call through. */
  resetTimeoutMs: number;
  /**
   * Which errors say the dependency is unhealthy. A rejected request (4xx) is not:
   * the dependency answered, the request was wrong.
   */
  isFailure: (error: unknown) => boolean;
  now?: () => number;
  onStateChange?: (state: CircuitState) => void;
}

export class CircuitOpenError extends Error {
  override name = 'CircuitOpenError';
  constructor() {
    super('Circuit is open: the dependency is considered down');
  }
}

/**
 *   closed ──(N consecutive failures)──▶ open ──(reset timeout)──▶ half_open
 *     ▲                                   ▲                           │
 *     │                                   └──── trial fails ──────────┤
 *     └──────────────────────────── trial succeeds ───────────────────┘
 *
 * Open: calls fail fast without touching the dependency.
 * Half-open: exactly one trial call at a time decides whether to close or reopen.
 * In-process state: each app instance has its own circuit.
 */
export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    this.refresh();
    return this.current;
  }

  /** Whether a call would be attempted right now. No side effects on the dependency. */
  isAvailable(): boolean {
    this.refresh();
    if (this.current === 'open') return false;
    if (this.current === 'half_open') return !this.trialInFlight;
    return true;
  }

  async execute<T>(call: () => Promise<T>): Promise<T> {
    if (!this.isAvailable()) throw new CircuitOpenError();

    const isTrial = this.current === 'half_open';
    if (isTrial) this.trialInFlight = true;
    try {
      const result = await call();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.options.isFailure(error)) this.onFailure(isTrial);
      // Any answer that is not a failure proves the dependency is reachable.
      else if (isTrial) this.onSuccess();
      throw error;
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.current !== 'closed') this.transition('closed');
  }

  private onFailure(isTrial: boolean): void {
    this.failures += 1;
    if (isTrial || this.failures >= this.options.failureThreshold) {
      this.failures = 0;
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  /** Open becomes half-open lazily, the first time anyone looks after the timeout. */
  private refresh(): void {
    if (
      this.current === 'open' &&
      this.now() - this.openedAt >= this.options.resetTimeoutMs
    ) {
      this.transition('half_open');
    }
  }

  private transition(state: CircuitState): void {
    this.current = state;
    this.options.onStateChange?.(state);
  }
}
