import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { Queue } from 'bullmq';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  BullMqEnrichmentQueue,
  ENRICHMENT_QUEUE_NAME,
  type BullMqEnrichmentQueueSettings,
} from '../../src/orders/infra/queue/bullmq-enrichment.queue.js';
import { waitFor } from '../helpers/wait-for.js';

const REDIS_IMAGE = 'redis:7.4-alpine';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const startRedis = (hostPort?: number) =>
  new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(hostPort ? { container: 6379, host: hostPort } : 6379)
    .start();

const docker = (...args: string[]) => execFileSync('docker', args);

/** Resolves with how long the promise took to settle, and whether it rejected. */
async function timed(promise: Promise<unknown>) {
  const started = Date.now();
  const rejected = await promise.then(
    () => false,
    () => true,
  );
  return { rejected, ms: Date.now() - started };
}

const job = (key: string) => ({
  jobId: key,
  orderId: `order-of-${key}`,
  requestId: `req-${key}`,
});

describe('BullMqEnrichmentQueue (integration)', () => {
  const settings = (redis: {
    host: string;
    port: number;
  }): BullMqEnrichmentQueueSettings => ({
    ...redis,
    commandTimeoutMs: 500,
    attempts: 5,
    backoffMs: 1000,
  });

  describe('with Redis up', () => {
    let redis: StartedTestContainer;
    let queue: BullMqEnrichmentQueue;
    let inspector: Queue;

    beforeAll(async () => {
      redis = await startRedis();
      inspector = new Queue(ENRICHMENT_QUEUE_NAME, {
        connection: { host: redis.getHost(), port: redis.getMappedPort(6379) },
      });
    });

    beforeEach(async () => {
      await inspector.obliterate({ force: true });
      queue = new BullMqEnrichmentQueue(
        settings({ host: redis.getHost(), port: redis.getMappedPort(6379) }),
      );
      await waitFor(async () => queue.isAvailable(), Boolean, {
        description: 'connection',
      });
    });

    afterEach(() => queue.close());
    afterAll(async () => {
      await inspector.close();
      await redis.stop();
    });

    it('enqueues a job with the order and request ids and the retry policy', async () => {
      await queue.enqueue(job('key-1'));

      const [stored] = await inspector.getJobs(['waiting']);
      expect(stored!.data).toEqual({
        orderId: 'order-of-key-1',
        requestId: 'req-key-1',
      });
      expect(stored!.opts.attempts).toBe(5);
      expect(stored!.opts.backoff).toEqual({
        type: 'exponential',
        delay: 1000,
      });
    });

    it('keeps a single job when the same jobId is enqueued twice', async () => {
      await queue.enqueue(job('key-1'));
      await queue.enqueue(job('key-1'));

      expect(await inspector.getJobCountByTypes('waiting')).toBe(1);
    });

    it.each(['12345', 'tenant:order:1', 'a:b'])(
      'accepts the client key %s, which BullMQ refuses as a raw job id, and still dedups it',
      async (key) => {
        await queue.enqueue(job(key));
        await queue.enqueue(job(key));

        expect(await inspector.getJobCountByTypes('waiting')).toBe(1);
      },
    );

    it('does not mix up keys that only differ by characters an encoding could collapse', async () => {
      await queue.enqueue(job('a:b'));
      await queue.enqueue(job('a_b'));
      await queue.enqueue(job('a-b'));

      expect(await inspector.getJobCountByTypes('waiting')).toBe(3);
    });

    it('reports itself available', () => {
      expect(queue.isAvailable()).toBe(true);
    });
  });

  describe('failing fast when Redis is unavailable', () => {
    let redis: StartedTestContainer | undefined;
    let queue: BullMqEnrichmentQueue | undefined;

    afterEach(async () => {
      await queue?.close();
      await redis?.stop().catch(() => undefined);
      queue = undefined;
      redis = undefined;
    });

    it('Redis frozen (connection open, no answers): rejects within the command timeout, then recovers', async () => {
      redis = await startRedis();
      queue = new BullMqEnrichmentQueue(
        settings({ host: redis.getHost(), port: redis.getMappedPort(6379) }),
      );
      await waitFor(async () => queue!.isAvailable(), Boolean, {
        description: 'connection',
      });

      docker('pause', redis.getId());
      const frozen = await timed(queue.enqueue(job('key-1')));
      docker('unpause', redis.getId());

      expect(frozen.rejected).toBe(true);
      // commandTimeout is 500 ms: well under a second proves it is what fails the command.
      expect(frozen.ms).toBeLessThan(900);
      await expect(queue.enqueue(job('key-2'))).resolves.toBeUndefined();
    });

    it('Redis stopped: reports unavailable and rejects at once', async () => {
      redis = await startRedis();
      queue = new BullMqEnrichmentQueue(
        settings({ host: redis.getHost(), port: redis.getMappedPort(6379) }),
      );
      await waitFor(async () => queue!.isAvailable(), Boolean, {
        description: 'connection',
      });

      docker('stop', '-t', '0', redis.getId());
      await waitFor(
        async () => queue!.isAvailable(),
        (up) => !up,
        {
          description: 'disconnect',
        },
      );
      const stopped = await timed(queue.enqueue(job('key-1')));

      expect(stopped.rejected).toBe(true);
      expect(stopped.ms).toBeLessThan(300);
    });

    it('app booted before Redis: rejects at once instead of hanging, works once Redis is up', async () => {
      const port = await freePort();
      queue = new BullMqEnrichmentQueue(settings({ host: '127.0.0.1', port }));

      const beforeRedis = await timed(queue.enqueue(job('key-1')));
      expect(queue.isAvailable()).toBe(false);
      expect(beforeRedis.rejected).toBe(true);
      expect(beforeRedis.ms).toBeLessThan(300);

      redis = await startRedis(port);
      await waitFor(async () => queue!.isAvailable(), Boolean, {
        timeoutMs: 15_000,
        description: 'reconnect',
      });
      await expect(queue.enqueue(job('key-2'))).resolves.toBeUndefined();
    });
  });
});
