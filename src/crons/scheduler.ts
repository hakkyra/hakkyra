/**
 * Cron trigger scheduler.
 *
 * Registers cron triggers with pg-boss for distributed, single-execution
 * scheduled job processing.
 */

import type { PgBoss, ScheduleOptions } from 'pg-boss';
import type { CronTriggerConfig } from '../types.js';

/**
 * Register all cron triggers with pg-boss.
 *
 * Each trigger is scheduled as a pg-boss cron job. pg-boss handles:
 * - Distributed single-execution via advisory locks
 * - Cron expression parsing and scheduling
 * - Retry with configurable backoff
 */
export async function registerCronTriggers(
  boss: PgBoss,
  triggers: CronTriggerConfig[],
): Promise<void> {
  for (const trigger of triggers) {
    const queueName = `cron:${trigger.name}`;
    const options: ScheduleOptions = {};

    // Configure retry from trigger config
    if (trigger.retryConf) {
      options.retryLimit = trigger.retryConf.numRetries;
      options.retryDelay = trigger.retryConf.retryIntervalSeconds;
      options.retryBackoff = true;
      options.expireInSeconds = trigger.retryConf.timeoutSeconds;
    }

    await boss.schedule(
      queueName,
      trigger.schedule,
      { payload: trigger.payload ?? null },
      options,
    );
  }
}
