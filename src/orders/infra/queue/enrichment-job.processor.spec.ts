import { RateLimitError, UnrecoverableError } from 'bullmq';
import {
  EnrichmentFailed,
  ExchangeProviderPaused,
  RetryEnrichmentLater,
  type EnrichOrderCommand,
  type EnrichOrderResult,
} from '../../application/enrich-order.use-case.js';
import { FailureReason } from '../../domain/order-status.js';
import {
  EnrichmentJobProcessor,
  ReleaseJobForSweeper,
  type DeadLetter,
  type EnrichmentJobLike,
} from './enrichment-job.processor.js';

describe('EnrichmentJobProcessor (EnrichOrder outcome → BullMQ)', () => {
  let outcome: () => Promise<EnrichOrderResult>;
  let commands: EnrichOrderCommand[];
  let deadLetters: DeadLetter[];
  let pauses: number[];

  const processor = () =>
    new EnrichmentJobProcessor(
      {
        execute: async (command) => {
          commands.push(command);
          return outcome();
        },
      },
      { add: async (entry) => void deadLetters.push(entry) },
      { pauseFor: async (ms) => void pauses.push(ms) },
      { pauseWhenProviderDownMs: 30_000 },
    );

  const job = (attemptsMade = 0, attempts = 3): EnrichmentJobLike => ({
    id: 'k_a2V5LTE',
    data: { orderId: 'order-1', requestId: 'req_1' },
    attemptsMade,
    opts: { attempts },
  });
  const failWith = (error: Error) => {
    outcome = async () => {
      throw error;
    };
  };

  beforeEach(() => {
    outcome = async () => ({ outcome: 'enriched' });
    commands = [];
    deadLetters = [];
    pauses = [];
  });

  it('runs EnrichOrder with the 1-based attempt and the job attempt budget', async () => {
    const result = await processor().process(job(1, 5));

    expect(result).toEqual({ outcome: 'enriched' });
    expect(commands).toEqual([
      { orderId: 'order-1', attempt: 2, maxAttempts: 5 },
    ]);
  });

  it('treats a job without an attempt budget as a single attempt', async () => {
    await processor().process({ ...job(0), opts: {} });

    expect(commands[0]).toMatchObject({ attempt: 1, maxAttempts: 1 });
  });

  describe('provider paused (circuit open)', () => {
    it('pauses the whole queue and hands the job back without spending an attempt', async () => {
      failWith(new ExchangeProviderPaused());

      await expect(processor().process(job())).rejects.toBeInstanceOf(
        RateLimitError,
      );
      expect(pauses).toEqual([30_000]);
    });
  });

  describe('final failure (order is FAILED_ENRICHMENT)', () => {
    it('copies the job to the dead letter queue and fails it for good', async () => {
      failWith(
        new EnrichmentFailed(
          FailureReason.PROVIDER_REJECTED,
          new Error('404 not found'),
        ),
      );

      await expect(processor().process(job(0, 3))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(deadLetters).toEqual([
        {
          jobId: 'k_a2V5LTE',
          orderId: 'order-1',
          requestId: 'req_1',
          reason: FailureReason.PROVIDER_REJECTED,
          error: expect.stringContaining('404 not found'),
          attempts: 1,
          failedAt: expect.any(String),
        },
      ]);
    });
  });

  describe('temporary failure', () => {
    it('with attempts left, rethrows so BullMQ retries with backoff', async () => {
      const retry = new RetryEnrichmentLater(new Error('503'));
      failWith(retry);

      await expect(processor().process(job(0, 3))).rejects.toBe(retry);
      expect(deadLetters).toEqual([]);
    });

    it('on the last attempt (order still RECEIVED), releases the job id for the orphan sweeper', async () => {
      failWith(new RetryEnrichmentLater(new Error('client updated the order')));

      await expect(processor().process(job(2, 3))).rejects.toBeInstanceOf(
        ReleaseJobForSweeper,
      );
      expect(deadLetters).toEqual([]);
    });
  });

  describe('unexpected error (e.g. database down before the order was touched)', () => {
    it('with attempts left, rethrows it', async () => {
      const boom = new Error('mongo down');
      failWith(boom);

      await expect(processor().process(job(0, 3))).rejects.toBe(boom);
    });

    it('on the last attempt, releases the job id for the orphan sweeper', async () => {
      failWith(new Error('mongo down'));

      await expect(processor().process(job(2, 3))).rejects.toBeInstanceOf(
        ReleaseJobForSweeper,
      );
    });
  });
});
