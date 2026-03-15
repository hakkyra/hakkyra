import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { createRequire } from 'node:module';

// Resolve graphql from the actual node_modules (handles git worktrees where
// import.meta.dirname may not be where node_modules lives).
const require_ = createRequire(import.meta.url);
const graphqlDir = path.dirname(require_.resolve('graphql/package.json'));

export default defineConfig({
  resolve: {
    // Force a single graphql instance to avoid ESM/CJS dual-package hazard
    alias: {
      graphql: path.join(graphqlDir, 'index.mjs'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
