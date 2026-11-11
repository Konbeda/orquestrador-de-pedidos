import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module.js';

/**
 * Boots the real AppModule against the test containers.
 * Each call gets its own database, so suites never see each other's data.
 */
export async function createTestApp(
  env: Record<string, string> = {},
): Promise<INestApplication> {
  const database = `test_${randomUUID().replaceAll('-', '')}`;
  const mongoUri = inject('mongoUri').replace(/\/(\?|$)/, `/${database}$1`);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    MONGO_URI: mongoUri,
    REDIS_HOST: inject('redisHost'),
    REDIS_PORT: String(inject('redisPort')),
    // Fast retries so the retry/DLQ flow runs in milliseconds.
    ENRICHMENT_MAX_ATTEMPTS: '3',
    ENRICHMENT_BACKOFF_MS: '10',
    ...env,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register()],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}
