import { PeriodicTask } from './periodic-task.js';

describe('PeriodicTask', () => {
  let results: unknown[];
  let errors: unknown[];

  const periodic = <T>(run: () => Promise<T>, intervalMs = 1000) =>
    new PeriodicTask(run, {
      intervalMs,
      onResult: (result) => results.push(result),
      onError: (error) => errors.push(error),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    results = [];
    errors = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once per interval after start, not immediately', async () => {
    const run = vi.fn(async () => 'swept');
    const task = periodic(run);

    task.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);

    expect(run).toHaveBeenCalledTimes(3);
    expect(results).toEqual(['swept', 'swept', 'swept']);
    await task.stop();
  });

  it('never overlaps: a tick that finds the previous run still going is skipped', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const task = periodic(run);
    task.start();

    await vi.advanceTimersByTimeAsync(1000); // run #1 starts and hangs
    await vi.advanceTimersByTimeAsync(3000); // three ticks while it is still going
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    await task.stop();
  });

  it('a failing run is reported and the schedule goes on', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValue('swept');
    const task = periodic(run);
    task.start();

    await vi.advanceTimersByTimeAsync(2000);

    expect(errors).toEqual([new Error('mongo down')]);
    expect(results).toEqual(['swept']);
    await task.stop();
  });

  it('stop() prevents further runs and waits for the one in progress', async () => {
    let finish!: () => void;
    let finished = false;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            finished = true;
            resolve();
          };
        }),
    );
    const task = periodic(run);
    task.start();
    await vi.advanceTimersByTimeAsync(1000);

    let stopped = false;
    const stopping = task.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    // Still waiting: the run in progress has not finished yet.
    expect(stopped).toBe(false);

    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);

    expect(finished).toBe(true);
    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('start() twice does not schedule twice', async () => {
    const run = vi.fn(async () => undefined);
    const task = periodic(run);

    task.start();
    task.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(1);
    await task.stop();
  });
});
