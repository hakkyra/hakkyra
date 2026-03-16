/**
 * Cron trigger manager.
 *
 * Wraps cron trigger initialization in a ServiceManager-compatible interface
 * for uniform lifecycle management alongside events and async actions.
 */

import type { Logger } from 'pino';
import type { CronTriggerConfig } from '../types.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import type { ServiceManager } from '../shared/service-manager.js';
import { registerCronTriggers } from './scheduler.js';
import { registerCronWorkers } from './worker.js';

export interface CronManagerDeps {
  jobQueue: JobQueue;
  triggers: CronTriggerConfig[];
  logger: Logger;
}

/**
 * Create a CronManager that conforms to the ServiceManager interface.
 */
export function createCronManager(deps: CronManagerDeps): ServiceManager {
  const { jobQueue, triggers, logger } = deps;

  return {
    async init(): Promise<void> {
      if (triggers.length === 0) {
        logger.info('No cron triggers configured');
        return;
      }

      await registerCronTriggers(jobQueue, triggers);
      await registerCronWorkers(jobQueue, triggers, logger);

      logger.info({ count: triggers.length }, 'Cron triggers initialized');
    },

    async stop(): Promise<void> {
      // Cron workers are stopped when the job queue itself is stopped.
      // No additional cleanup needed.
    },
  };
}
