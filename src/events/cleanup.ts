/**
 * Event log cleanup.
 *
 * Periodically removes old delivered events from the event_log table
 * based on a configurable retention period.
 */

import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

/**
 * Register a cleanup job that runs daily to remove old delivered events.
 *
 * @param boss - pg-boss instance
 * @param pool - Database connection pool
 * @param retentionDays - Number of days to retain delivered events (default: 7)
 * @param logger - Logger instance
 */
export async function registerEventCleanup(
  boss: PgBoss,
  pool: Pool,
  retentionDays: number = 7,
  logger: Logger,
): Promise<void> {
  const queueName = 'hakkyra/cleanup_events';

  // Schedule daily cleanup at 3 AM
  await boss.schedule(queueName, '0 3 * * *', { retentionDays });

  await boss.work(queueName, async (_jobs) => {
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
