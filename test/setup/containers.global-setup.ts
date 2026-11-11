import {
  MongoDBContainer,
  type StartedMongoDBContainer,
} from '@testcontainers/mongodb';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    redisHost: string;
    redisPort: number;
  }
}

let mongo: StartedMongoDBContainer;
let redis: StartedRedisContainer;

/**
 * Starts Mongo and Redis once per test run and hands their addresses to the
 * test files through `inject()`. Same images as docker-compose.yml.
 */
export async function setup(project: TestProject) {
  [mongo, redis] = await Promise.all([
    new MongoDBContainer('mongo:8.0').start(),
    new RedisContainer('redis:7.4-alpine')
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .start(),
  ]);

  project.provide(
    'mongoUri',
    `${mongo.getConnectionString().replace(/\/$/, '')}/?directConnection=true`,
  );
  project.provide('redisHost', redis.getHost());
  project.provide('redisPort', redis.getPort());
}

export async function teardown() {
  await Promise.all([mongo?.stop(), redis?.stop()]);
}
