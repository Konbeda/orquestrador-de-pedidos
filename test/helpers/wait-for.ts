/**
 * Polls until `probe` returns a value accepted by `until`, or fails after `timeoutMs`.
 *
 * Queue work happens in another async flow (and BullMQ delays live in Redis),
 * so fake timers cannot drive it: tests wait for the observable outcome instead.
 */
export async function waitFor<T>(
  probe: () => Promise<T>,
  until: (value: T) => boolean,
  { timeoutMs = 10_000, intervalMs = 50, description = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (until(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}. Last value: ${JSON.stringify(last)}`,
  );
}
