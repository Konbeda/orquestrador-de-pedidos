import { z } from 'zod';

const iso4217 = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code (3 letters)');

const positiveInt = z.coerce.number().int().positive();

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  BODY_LIMIT: z.string().default('100kb'),

  MONGO_URI: z.string().min(1),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),

  FRANKFURTER_BASE_URL: z.url().default('https://api.frankfurter.dev/v1'),
  FRANKFURTER_TIMEOUT_MS: positiveInt.default(3000),
  SUPPORTED_CURRENCIES_TTL_MS: positiveInt.default(6 * 60 * 60 * 1000),
  SUPPORTED_CURRENCIES_FALLBACK: z
    .string()
    .default('USD,EUR,BRL,GBP,JPY')
    .transform((list) =>
      list.split(',').map((code) => code.trim().toUpperCase()),
    )
    .pipe(z.array(iso4217).min(1)),

  ENRICHMENT_TARGET_CURRENCY: iso4217.default('BRL'),
  ENRICHMENT_MAX_ATTEMPTS: positiveInt.default(5),
  ENRICHMENT_BACKOFF_MS: positiveInt.default(1000),
  ENRICHMENT_CONCURRENCY: positiveInt.default(5),
  /** Comma-separated waits between enqueue attempts inside the webhook request. */
  ENQUEUE_RETRY_DELAYS_MS: z
    .string()
    .default('100,200,400')
    .transform((list) =>
      list
        .split(',')
        .map((delay) => delay.trim())
        .filter((delay) => delay.length > 0)
        .map(Number),
    )
    // 'abc' becomes NaN, which z.number() refuses.
    .pipe(z.array(z.number().int().nonnegative())),

  CIRCUIT_FAILURE_THRESHOLD: positiveInt.default(5),
  CIRCUIT_RESET_TIMEOUT_MS: positiveInt.default(30_000),

  REPROCESS_MAX_COUNT: positiveInt.default(3),
  REPROCESS_RATE_PER_SECOND: positiveInt.default(5),

  // Orphan sweeper: RECEIVED orders unchecked for STALE_ORDER_AFTER_MS get enqueued again.
  SWEEP_INTERVAL_MS: positiveInt.default(60_000),
  STALE_ORDER_AFTER_MS: positiveInt.default(120_000),
  SWEEP_BATCH_SIZE: positiveInt.default(100),

  ORDER_DUPLICATE_POLICY: z.enum(['reject', 'update']).default('reject'),
  MAX_ORDER_REVISIONS: positiveInt.default(10),
  REJECTION_RETENTION_DAYS: positiveInt.default(90),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Used by ConfigModule at boot: an invalid environment stops the app
 * with every problem listed, instead of failing later at runtime.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
