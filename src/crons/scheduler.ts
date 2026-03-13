/**
 * Cron trigger scheduler.
 *
 * Registers cron triggers with pg-boss for distributed, single-execution
 * scheduled job processing.
 */

import type { CronTriggerConfig } from '../types.js';
import type { JobQueue, ScheduleOptions } from '../shared/job-queue/types.js';

/**
 * Register all cron triggers with the job queue.
 *
 * Each trigger is scheduled as a cron job. The underlying provider handles:
 * - Distributed single-execution
 * - Cron expression parsing and scheduling
 * - Retry with configurable backoff
 */
export async function registerCronTriggers(
  jobQueue: JobQueue,
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

    await jobQueue.schedule(
      queueName,
      trigger.schedule,
      { payload: trigger.payload ?? null },
      options,
    );
  }
}
