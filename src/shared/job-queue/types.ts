/**
 * Job queue abstraction layer types.
 *
 * Defines the interface that both pg-boss and BullMQ adapters must implement,
 * allowing the job queue backend to be swapped without changing consumer code.
 */

// ─── Job types ──────────────────────────────────────────────────────────────

export interface JobData {
  [key: string]: unknown;
}

export interface Job<T extends JobData = JobData> {
  id: string;
  name: string;
  data: T;
}

// ─── Queue configuration ────────────────────────────────────────────────────

export interface QueueOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
}

export interface ScheduleOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
}

// ─── Worker options ─────────────────────────────────────────────────────────

export interface WorkOptions {
  /** Number of jobs to process concurrently (default: 1). */
  concurrency?: number;
}

// ─── Handler type ───────────────────────────────────────────────────────────

export type JobHandler<T extends JobData = JobData> = (jobs: Job<T>[]) => Promise<void>;

// ─── Core interface ─────────────────────────────────────────────────────────

/**
 * Abstract job queue interface.
 *
 * Implementations must support:
 * - Lifecycle management (start/stop)
 * - Job enqueuing (send)
 * - Worker registration (work)
 * - Queue creation with retry config (createQueue)
 * - Cron-based scheduling (schedule)
 */
export interface JobQueue {
  /** Start the job queue system. Must be called before send/work/schedule. */
  start(): Promise<void>;

  /** Gracefully stop the job queue system. */
  stop(): Promise<void>;

  /** Enqueue a job. Returns the job ID or null if enqueue was skipped. */
  send<T extends JobData>(queue: string, data: T): Promise<string | null>;

  /** Register a worker for a queue. Handler receives an array of jobs. */
  work<T extends JobData>(queue: string, handler: JobHandler<T>, options?: WorkOptions): Promise<void>;

  /** Create/configure a queue with options (retry, expiry, etc.). */
  createQueue(name: string, options?: QueueOptions): Promise<void>;

  /** Register a cron schedule that enqueues jobs on the given pattern. */
  schedule(name: string, cron: string, data?: JobData, options?: ScheduleOptions): Promise<void>;
}

// ─── Provider configuration ─────────────────────────────────────────────────

export type JobQueueProvider = 'pg-boss' | 'bullmq';

export interface JobQueueConfig {
  provider: JobQueueProvider;
  /** pg-boss uses the database connection string. */
  connectionString?: string;
  /** BullMQ needs Redis connection info. */
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
  };
  /** Timeout in milliseconds for graceful shutdown (default: 10000). */
  gracefulShutdownMs?: number;
  /** Internal schema name prefix for pg-boss tables (default: 'hakkyra'). */
  schemaName?: string;
}
