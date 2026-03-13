import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // Force a single graphql instance to avoid ESM/CJS dual-package hazard
    alias: {
      graphql: path.resolve(import.meta.dirname, 'node_modules/graphql/index.mjs'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
