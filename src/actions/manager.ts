/**
 * Async action manager.
 *
 * Wraps async action initialization (schema setup + worker registration)
 * in a ServiceManager-compatible interface for uniform lifecycle management
 * alongside events and crons.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ActionConfig } from '../types.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import type { ServiceManager } from '../shared/service-manager.js';
import { ensureAsyncActionSchema } from './async-schema.js';
import { registerAsyncActionWorkers } from './async.js';

export interface ActionManagerDeps {
  jobQueue: JobQueue;
  pool: Pool;
  actions: ActionConfig[];
  logger: Logger;
}

/**
 * Create an ActionManager that conforms to the ServiceManager interface.
 */
export function createActionManager(deps: ActionManagerDeps): ServiceManager {
  const { jobQueue, pool, actions, logger } = deps;

  return {
    async init(): Promise<void> {
      const asyncActions = actions.filter((a) => a.definition.kind === 'asynchronous');

      if (asyncActions.length === 0) {
        return;
      }

      await ensureAsyncActionSchema(pool);
      await registerAsyncActionWorkers(jobQueue, pool, actions, logger);

      logger.info(
        { count: asyncActions.length, actions: asyncActions.map((a) => a.name) },
        'Async action system initialized',
      );
    },

    async stop(): Promise<void> {
      // Async action workers are stopped when the job queue itself is stopped.
      // No additional cleanup needed.
    },
  };
}
