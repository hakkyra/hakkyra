/**
 * Event log cleanup.
 *
 * Periodically removes old delivered events from the event_log table
 * based on a configurable retention period.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { JobQueue } from '../shared/job-queue/types.js';

export interface EventCleanupOptions {
  /** Cron schedule for the cleanup job (default: '0 3 * * *'). */
  schedule?: string;
}

/**
 * Register a cleanup job that runs daily to remove old delivered events.
 *
 * @param jobQueue - Job queue instance
 * @param pool - Database connection pool
 * @param retentionDays - Number of days to retain delivered events (default: 7)
 * @param logger - Logger instance
 * @param options - Optional configuration overrides
 */
export async function registerEventCleanup(
  jobQueue: JobQueue,
  pool: Pool,
  retentionDays: number = 7,
  logger: Logger,
  options?: EventCleanupOptions,
): Promise<void> {
  const queueName = 'hakkyra/cleanup_events';
  const schedule = options?.schedule ?? '0 3 * * *';

  // Schedule cleanup
  await jobQueue.schedule(queueName, schedule, { retentionDays });

  await jobQueue.work(queueName, async (_jobs) => {
    const result = await pool.query(
      `DELETE FROM hakkyra.event_log
       WHERE status = 'delivered'
       AND delivered_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );

    logger.info(
      { deletedCount: result.rowCount, retentionDays },
      'Event log cleanup completed',
    );
  });
}
