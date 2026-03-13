/**
 * Cron Triggers module.
 *
 * Registers cron schedules and webhook delivery workers with pg-boss.
 */

import type { Logger } from 'pino';
import type { CronTriggerConfig } from '../types.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import { registerCronTriggers } from './scheduler.js';
import { registerCronWorkers } from './worker.js';

export { registerCronTriggers } from './scheduler.js';
export { registerCronWorkers } from './worker.js';

/**
 * Initialize all cron triggers: register schedules and start workers.
 */
export async function initCronTriggers(
  jobQueue: JobQueue,
  triggers: CronTriggerConfig[],
  logger: Logger,
): Promise<void> {
  if (triggers.length === 0) {
    logger.info('No cron triggers configured');
    return;
  }

  await registerCronTriggers(jobQueue, triggers);
  await registerCronWorkers(jobQueue, triggers, logger);

  logger.info({ count: triggers.length }, 'Cron triggers initialized');
}
