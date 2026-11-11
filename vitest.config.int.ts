import { defineConfig } from 'vitest/config';

// Integration tests: each adapter against real Mongo/Redis (Testcontainers) and mocked HTTP (nock).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.int-spec.ts'],
    globalSetup: ['test/setup/containers.global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Suites share one Mongo and one Redis; running files one at a time keeps them isolated.
    fileParallelism: false,
  },
});
