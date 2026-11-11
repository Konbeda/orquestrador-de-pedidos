import { defineConfig } from 'vitest/config';

// End-to-end: the whole Nest app over HTTP, the real queue and worker, Frankfurter mocked.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    globalSetup: ['test/setup/containers.global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
