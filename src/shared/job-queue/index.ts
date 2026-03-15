/**
 * Job queue abstraction layer.
 *
 * Factory function that creates either a pg-boss or BullMQ backed
 * job queue based on configuration. pg-boss is the default and
 * requires no additional dependencies. BullMQ requires Redis and
 * the 'bullmq' npm package (optional dependency).
 */

export type {
  JobQueue,
  JobData,
  Job,
  JobHandler,
  QueueOptions,
  ScheduleOptions,
  JobQueueProvider,
  JobQueueConfig,
} from './types.js';

import type { JobQueue, JobQueueConfig } from './types.js';

/**
 * Create a JobQueue instance based on the provider configuration.
 *
 * - 'pg-boss' (default): Uses PostgreSQL via pg-boss. Requires connectionString.
 * - 'bullmq': Uses Redis via BullMQ. Requires redis config. The bullmq
 *   package is loaded dynamically and must be installed separately.
 */
export async function createJobQueue(config: JobQueueConfig): Promise<JobQueue> {
  if (config.provider === 'bullmq') {
    if (!config.redis) {
      throw new Error(
        'BullMQ provider requires redis configuration. ' +
        'Set job_queue.redis.url or job_queue.redis.host in your config.',
      );
    }
    const { BullMQAdapter } = await import('./bullmq-adapter.js');
    return new BullMQAdapter(config.redis);
  }

  // Default: pg-boss
  if (!config.connectionString) {
    throw new Error(
      'pg-boss provider requires a database connection string. ' +
      'Ensure DATABASE_URL (or the configured urlEnv) is set.',
    );
  }
  const { PgBossAdapter } = await import('./pg-boss-adapter.js');
  return new PgBossAdapter(config.connectionString, config.gracefulShutdownMs, config.schemaName);
}
