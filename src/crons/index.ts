/**
 * Cron Triggers module.
 *
 * Registers cron schedules and webhook delivery workers with pg-boss.
 */

import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { CronTriggerConfig } from '../types.js';
import { registerCronTriggers } from './scheduler.js';
import { registerCronWorkers } from './worker.js';

export { registerCronTriggers } from './scheduler.js';
export { registerCronWorkers } from './worker.js';

/**
 * Initialize all cron triggers: register schedules and start workers.
 */
export async function initCronTriggers(
  boss: PgBoss,
  triggers: CronTriggerConfig[],
  logger: Logger,
): Promise<void> {
  if (triggers.length === 0) {
    logger.info('No cron triggers configured');
    return;
  }

  await registerCronTriggers(boss, triggers);
  await registerCronWorkers(boss, triggers, logger);

  logger.info({ count: triggers.length }, 'Cron triggers initialized');
}
