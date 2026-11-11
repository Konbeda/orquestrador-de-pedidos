import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState,
} from './circuit-breaker.js';

class Outage extends Error {}
class BadRequest extends Error {}

describe('CircuitBreaker', () => {
  let now: number;
  let transitions: CircuitState[];

  const breaker = (failureThreshold = 3, resetTimeoutMs = 30_000) =>
    new CircuitBreaker({
      failureThreshold,
      resetTimeoutMs,
      // Only outages say something about the dependency's health.
      isFailure: (error) => error instanceof Outage,
      now: () => now,
      onStateChange: (state) => transitions.push(state),
    });

  const fail = (cb: CircuitBreaker, error: Error = new Outage()) =>
    cb
      .execute(async () => {
        throw error;
      })
      .catch(() => undefined);
  const succeed = (cb: CircuitBreaker) => cb.execute(async () => 'ok');

  beforeEach(() => {
    now = 0;
    transitions = [];
  });

  describe('closed', () => {
    it('passes calls through and returns their result', async () => {
      const cb = breaker();

      await expect(cb.execute(async () => 42)).resolves.toBe(42);
      expect(cb.state).toBe('closed');
      expect(cb.isAvailable()).toBe(true);
    });

    it('rethrows the call error unchanged', async () => {
      const outage = new Outage('503');

      await expect(
        breaker().execute(async () => {
          throw outage;
        }),
      ).rejects.toBe(outage);
    });

    it('opens after N consecutive failures', async () => {
      const cb = breaker(3);

      await fail(cb);
      await fail(cb);
      expect(cb.state).toBe('closed');
      await fail(cb);

      expect(cb.state).toBe('open');
      expect(transitions).toEqual(['open']);
    });

    it('a success resets the count: failures must be consecutive', async () => {
      const cb = breaker(3);

      await fail(cb);
      await fail(cb);
      await succeed(cb);
      await fail(cb);
      await fail(cb);

      expect(cb.state).toBe('closed');
    });

    it('errors that are not failures (e.g. 4xx) neither count nor reset the count', async () => {
      const cb = breaker(3);

      await fail(cb);
      await fail(cb, new BadRequest());
      await fail(cb);
      await fail(cb, new BadRequest());
      await fail(cb, new BadRequest());
      // 2 outages so far: 4xx did not count...
      expect(cb.state).toBe('closed');
      await fail(cb);

      // ...nor reset the count: the 3rd outage opens it.
      expect(cb.state).toBe('open');
    });
  });

  describe('open', () => {
    it('fails fast without calling the dependency', async () => {
      const cb = breaker(1);
      await fail(cb);
      const call = vi.fn(async () => 'ok');

      await expect(cb.execute(call)).rejects.toThrow(CircuitOpenError);
      expect(call).not.toHaveBeenCalled();
      expect(cb.isAvailable()).toBe(false);
    });

    it('stays open until the reset timeout elapses', async () => {
      const cb = breaker(1, 30_000);
      await fail(cb);

      now = 29_999;

      expect(cb.state).toBe('open');
    });
  });

  describe('half-open', () => {
    async function halfOpen() {
      // Threshold 3: a single failed trial reopening it can only be the half-open rule.
      const cb = breaker(3, 30_000);
      await fail(cb);
      await fail(cb);
      await fail(cb);
      now = 30_000;
      return cb;
    }

    it('lets a trial call through once the reset timeout elapses', async () => {
      const cb = await halfOpen();

      expect(cb.state).toBe('half_open');
      expect(cb.isAvailable()).toBe(true);
      await expect(cb.execute(async () => 'ok')).resolves.toBe('ok');
    });

    it('closes when the trial succeeds', async () => {
      const cb = await halfOpen();

      await succeed(cb);

      expect(cb.state).toBe('closed');
      expect(transitions).toEqual(['open', 'half_open', 'closed']);
    });

    it('reopens at once when the trial fails, for another full timeout', async () => {
      const cb = await halfOpen();

      await fail(cb);

      expect(cb.state).toBe('open');
      now = 59_999;
      expect(cb.state).toBe('open');
      now = 60_000;
      expect(cb.state).toBe('half_open');
    });

    it('allows a single trial at a time; concurrent calls fail fast', async () => {
      const cb = await halfOpen();
      let finishTrial!: () => void;
      const trial = cb.execute(
        () =>
          new Promise<string>((resolve) => (finishTrial = () => resolve('ok'))),
      );

      await expect(cb.execute(async () => 'other')).rejects.toThrow(
        CircuitOpenError,
      );
      expect(cb.isAvailable()).toBe(false);

      finishTrial();
      await trial;
      expect(cb.state).toBe('closed');
    });

    it('a trial ending in a non-failure error (e.g. 4xx) proves the dependency answers: closes', async () => {
      const cb = await halfOpen();

      await fail(cb, new BadRequest());

      expect(cb.state).toBe('closed');
    });
  });
});
