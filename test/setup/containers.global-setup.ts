import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
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

const MONGO_PORT = 27017;

let mongo: StartedTestContainer;
let redis: StartedRedisContainer;

/**
 * Starts Mongo and Redis once per test run and hands their addresses to the
 * test files through `inject()`. Same images as docker-compose.yml.
 *
 * Mongo runs standalone, like in docker-compose. @testcontainers/mongodb starts
 * a replica set whose health check (rs.initiate through mongosh) was reported
 * unhealthy on GitHub's runners; the project needs no replica set (no
 * transactions, no change streams), so the container is ready once Mongo itself
 * logs that it accepts connections.
 */
export async function setup(project: TestProject) {
  [mongo, redis] = await Promise.all([
    new GenericContainer('mongo:8.2')
      .withExposedPorts(MONGO_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
      .withStartupTimeout(120_000)
      .start(),
    new RedisContainer('redis:7.4-alpine')
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .start(),
  ]);

  project.provide(
    'mongoUri',
    `mongodb://${mongo.getHost()}:${mongo.getMappedPort(MONGO_PORT)}/`,
  );
  project.provide('redisHost', redis.getHost());
  project.provide('redisPort', redis.getPort());
}

export async function teardown() {
  await Promise.all([mongo?.stop(), redis?.stop()]);
}
