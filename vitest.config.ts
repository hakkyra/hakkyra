import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { createRequire } from 'node:module';

// Resolve graphql from the actual node_modules (handles git worktrees where
// import.meta.dirname may not be where node_modules lives).
const require_ = createRequire(import.meta.url);
// (graphql 17's exports map no longer exposes package.json, so resolve the
// entry point instead — it sits at the package root.)
const graphqlDir = path.dirname(require_.resolve('graphql'));

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
