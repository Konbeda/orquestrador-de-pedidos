export interface PeriodicTaskOptions<T> {
  intervalMs: number;
  onResult?: (result: T) => void;
  onError?: (error: unknown) => void;
}

/**
 * Runs `run` every `intervalMs`, in process, with no overlap: a tick that finds
 * the previous run still going is skipped (a slow sweep must not pile up).
 * A failing run is reported and the schedule continues.
 *
 * Deliberately not a BullMQ repeatable job: the orphan sweeper exists for when
 * Redis failed, so it cannot depend on Redis to fire.
 */
export class PeriodicTask<T> {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly run: () => Promise<T>,
    private readonly options: PeriodicTaskOptions<T>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
    // Never keeps the process alive on its own.
    this.timer.unref?.();
  }

  /** Stops scheduling and waits for the run in progress, if any. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.run()
      .then(
        (result) => this.options.onResult?.(result),
        (error: unknown) => this.options.onError?.(error),
      )
      .finally(() => {
        this.running = null;
      });
  }
}
