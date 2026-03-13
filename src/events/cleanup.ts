/**
 * Event log cleanup.
 *
 * Periodically removes old delivered events from the event_log table
 * based on a configurable retention period.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { JobQueue } from '../shared/job-queue/types.js';

/**
 * Register a cleanup job that runs daily to remove old delivered events.
 *
 * @param jobQueue - Job queue instance
 * @param pool - Database connection pool
 * @param retentionDays - Number of days to retain delivered events (default: 7)
 * @param logger - Logger instance
 */
export async function registerEventCleanup(
  jobQueue: JobQueue,
  pool: Pool,
  retentionDays: number = 7,
  logger: Logger,
): Promise<void> {
  const queueName = 'hakkyra/cleanup_events';

  // Schedule daily cleanup at 3 AM
  await jobQueue.schedule(queueName, '0 3 * * *', { retentionDays });

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
