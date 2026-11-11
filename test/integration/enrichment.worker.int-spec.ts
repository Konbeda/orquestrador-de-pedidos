import { Queue, type Job } from 'bullmq';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  EnrichmentFailed,
  ExchangeProviderPaused,
  RetryEnrichmentLater,
  type EnrichOrderCommand,
  type EnrichOrderResult,
} from '../../src/orders/application/enrich-order.use-case.js';
import { FailureReason } from '../../src/orders/domain/order-status.js';
import {
  BullMqEnrichmentQueue,
  ENRICHMENT_QUEUE_NAME,
  toJobId,
} from '../../src/orders/infra/queue/bullmq-enrichment.queue.js';
import {
  DEAD_LETTER_QUEUE_NAME,
  EnrichmentWorker,
} from '../../src/orders/infra/queue/enrichment.worker.js';
import { waitFor } from '../helpers/wait-for.js';

/** Scriptable EnrichOrder: each run takes the next step; the last one repeats. */
class ScriptedEnrichOrder {
  readonly commands: EnrichOrderCommand[] = [];
  constructor(private readonly steps: Array<() => EnrichOrderResult | Error>) {}
  async execute(command: EnrichOrderCommand): Promise<EnrichOrderResult> {
    this.commands.push(command);
    const step =
      this.steps[Math.min(this.commands.length, this.steps.length) - 1]!();
    if (step instanceof Error) throw step;
    return step;
  }
}

const enriched = () => ({ outcome: 'enriched' as const });

describe('EnrichmentWorker (integration, real Redis)', () => {
  let redis: StartedTestContainer;
  let connection: { host: string; port: number };
  let producer: BullMqEnrichmentQueue;
  let inspector: Queue;
  let deadLetters: Queue;
  let worker: EnrichmentWorker | undefined;

  const start = (enrich: ScriptedEnrichOrder) => {
    worker = new EnrichmentWorker(enrich, {
      ...connection,
      concurrency: 1,
      pauseWhenProviderDownMs: 100,
    });
    worker.start();
  };
  const enqueue = (key: string) =>
    producer.enqueue({
      jobId: key,
      orderId: `order-${key}`,
      requestId: `req-${key}`,
    });
  const jobOf = (key: string) => inspector.getJob(toJobId(key));
  const stateOf = async (key: string) =>
    (await jobOf(key))?.getState() ?? 'removed';

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7.4-alpine')
      .withExposedPorts(6379)
      .start();
    connection = { host: redis.getHost(), port: redis.getMappedPort(6379) };
    inspector = new Queue(ENRICHMENT_QUEUE_NAME, { connection });
    deadLetters = new Queue(DEAD_LETTER_QUEUE_NAME, { connection });
  });

  beforeEach(async () => {
    await inspector.obliterate({ force: true });
    await deadLetters.obliterate({ force: true });
    await inspector.removeRateLimitKey();
    producer = new BullMqEnrichmentQueue({
      ...connection,
      commandTimeoutMs: 1000,
      attempts: 3,
      backoffMs: 10,
    });
    await waitFor(async () => producer.isAvailable(), Boolean, {
      description: 'producer',
    });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await producer.close();
  });

  afterAll(async () => {
    await inspector.close();
    await deadLetters.close();
    await redis.stop();
  });

  it('completes the job when the order is enriched', async () => {
    const enrich = new ScriptedEnrichOrder([enriched]);
    start(enrich);

    await enqueue('ok');

    await waitFor(
      () => stateOf('ok'),
      (s) => s === 'completed',
      { description: 'completed' },
    );
    expect(enrich.commands).toEqual([
      { orderId: 'order-ok', attempt: 1, maxAttempts: 3 },
    ]);
  });

  it('retries temporary failures with backoff until it works', async () => {
    const enrich = new ScriptedEnrichOrder([
      () => new RetryEnrichmentLater(new Error('503')),
      () => new RetryEnrichmentLater(new Error('503')),
      enriched,
    ]);
    start(enrich);

    await enqueue('flaky');

    await waitFor(
      () => stateOf('flaky'),
      (s) => s === 'completed',
      { description: 'completed' },
    );
    expect(enrich.commands.map((c) => c.attempt)).toEqual([1, 2, 3]);
  });

  it('a final failure is not retried and lands in the dead letter queue', async () => {
    const enrich = new ScriptedEnrichOrder([
      () =>
        new EnrichmentFailed(FailureReason.PROVIDER_REJECTED, new Error('404')),
    ]);
    start(enrich);

    await enqueue('rejected');

    await waitFor(
      () => stateOf('rejected'),
      (s) => s === 'failed',
      { description: 'failed' },
    );
    expect(enrich.commands).toHaveLength(1);
    const [dead] = await waitFor(
      () => deadLetters.getJobs(['waiting']),
      (jobs: Job[]) => jobs.length === 1,
      { description: 'dead letter' },
    );
    expect(dead!.data).toMatchObject({
      jobId: toJobId('rejected'),
      orderId: 'order-rejected',
      requestId: 'req-rejected',
      reason: 'PROVIDER_REJECTED',
      attempts: 1,
    });
  });

  it('with the provider paused, holds the job without spending attempts, then runs it', async () => {
    const enrich = new ScriptedEnrichOrder([
      () => new ExchangeProviderPaused(),
      () => new ExchangeProviderPaused(),
      () => new ExchangeProviderPaused(),
      () => new ExchangeProviderPaused(),
      enriched,
    ]);
    start(enrich);

    await enqueue('paused');

    await waitFor(
      () => stateOf('paused'),
      (s) => s === 'completed',
      {
        description: 'completed after the pauses',
      },
    );
    // 4 pauses + 1 success with a budget of 3 attempts: pauses did not count.
    expect(enrich.commands).toHaveLength(5);
    expect(enrich.commands.every((c) => c.attempt === 1)).toBe(true);
  });

  it('takes new orders before low priority (reprocess) jobs, even ones enqueued earlier', async () => {
    const enrich = new ScriptedEnrichOrder([enriched]);
    await producer.enqueue({
      jobId: 'old',
      orderId: 'order-reprocess',
      requestId: 'r',
      priority: 'low',
    });
    await enqueue('fresh');

    start(enrich);

    await waitFor(
      async () => enrich.commands.length,
      (n) => n === 2,
      { description: 'both jobs' },
    );
    expect(enrich.commands.map((c) => c.orderId)).toEqual([
      'order-fresh',
      'order-reprocess',
    ]);
  });

  it('when attempts run out with the order still RECEIVED, frees the job id for the sweeper', async () => {
    const enrich = new ScriptedEnrichOrder([
      () => new RetryEnrichmentLater(new Error('503')),
    ]);
    start(enrich);
    await enqueue('orphan');

    await waitFor(
      () => stateOf('orphan'),
      (s) => s === 'removed',
      {
        description: 'failed job removed',
      },
    );
    expect(enrich.commands).toHaveLength(3);
    expect(await deadLetters.getJobCountByTypes('waiting')).toBe(0);

    // The sweeper can now enqueue the same job id again.
    await worker!.close();
    await enqueue('orphan');
    expect(await stateOf('orphan')).toBe('waiting');
  });
});
