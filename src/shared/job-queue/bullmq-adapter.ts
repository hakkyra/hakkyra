/**
 * BullMQ adapter for the JobQueue interface.
 *
 * Uses dynamic imports so BullMQ is only loaded when this adapter is
 * instantiated. The 'bullmq' package should be listed as an
 * optionalDependency — it is NOT required for the default pg-boss backend.
 *
 * Key mapping decisions:
 * - send()     -> Queue.add()
 * - work()     -> new Worker() with batched-style handler (wraps single jobs
 *                 in an array to match the pg-boss Job[] convention)
 * - schedule() -> Queue.upsertJobScheduler() with a cron repeat pattern
 * - createQueue() stores options for later use by work()/send()
 */

import type {
  JobQueue,
  JobData,
  JobHandler,
  Job,
  QueueOptions,
  ScheduleOptions,
  WorkOptions,
} from './types.js';

// BullMQ types imported lazily — we only define the shapes we need here so
// the module can be parsed without the bullmq package being installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BullQueue = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BullWorker = any;

interface RedisConfig {
  url?: string;
  urlEnv?: string;
  host?: string;
  port?: number;
  password?: string;
}

export class BullMQAdapter implements JobQueue {
  private redis: RedisConfig;
  private queues = new Map<string, BullQueue>();
  private workers: BullWorker[] = [];
  private queueOptions = new Map<string, QueueOptions>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bullmq: any; // lazily loaded module
  private connectionOpts: Record<string, unknown> = {};

  constructor(redis: RedisConfig) {
    this.redis = redis;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Dynamically import BullMQ — will throw a clear error if not installed
    try {
      // @ts-ignore — bullmq is an optional dependency, may not be installed
      this.bullmq = await import('bullmq');
    } catch {
      throw new Error(
        'BullMQ is not installed. Install it with: npm install bullmq\n' +
        'BullMQ is an optional dependency required only when job_queue.provider is set to "bullmq".',
      );
    }

    // Build IORedis-compatible connection options
    const resolvedUrl = this.redis.url ?? (this.redis.urlEnv ? process.env[this.redis.urlEnv] : undefined);
    if (resolvedUrl) {
      // Parse redis:// URL into host/port/password for IORedis
      const parsed = new URL(resolvedUrl);
      this.connectionOpts = {
        host: parsed.hostname || 'localhost',
        port: parseInt(parsed.port || '6379', 10),
        ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
      };
    } else {
      this.connectionOpts = {
        host: this.redis.host ?? 'localhost',
        port: this.redis.port ?? 6379,
        ...(this.redis.password ? { password: this.redis.password } : {}),
      };
    }
  }

  async stop(): Promise<void> {
    // Close all workers first, then queues
    const workerCloses = this.workers.map((w: BullWorker) => w.close());
    await Promise.all(workerCloses);

    const queueCloses = Array.from(this.queues.values()).map((q: BullQueue) => q.close());
    await Promise.all(queueCloses);

    this.workers = [];
    this.queues.clear();
  }

  // ── Queue operations ──────────────────────────────────────────────────

  async send<T extends JobData>(queue: string, data: T): Promise<string | null> {
    const q = this.getOrCreateQueue(queue);
    const opts = this.queueOptions.get(queue);

    // Map our abstract options to BullMQ job options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobOpts: Record<string, any> = {};
    if (opts?.retryLimit) {
      jobOpts.attempts = opts.retryLimit + 1; // BullMQ: attempts includes the initial try
      jobOpts.backoff = opts.retryBackoff
        ? { type: 'exponential', delay: (opts.retryDelay ?? 1) * 1000 }
        : { type: 'fixed', delay: (opts.retryDelay ?? 1) * 1000 };
    }
    if (opts?.expireInSeconds) {
      jobOpts.timeout = opts.expireInSeconds * 1000;
    }

    const job = await q.add(queue, data, jobOpts);
    return job.id ?? null;
  }

  async work<T extends JobData>(queue: string, handler: JobHandler<T>, options?: WorkOptions): Promise<void> {
    const { Worker: BullWorker } = this.bullmq;

    const worker = new BullWorker(
      queue,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (bullJob: any) => {
        // Wrap single BullMQ job in an array to match pg-boss convention
        const job: Job<T> = {
          id: bullJob.id,
          name: bullJob.name,
          data: bullJob.data as T,
        };
        await handler([job]);
      },
      {
        connection: this.connectionOpts,
        ...(options?.concurrency ? { concurrency: options.concurrency } : {}),
      },
    );

    this.workers.push(worker);
  }

  async createQueue(name: string, options?: QueueOptions): Promise<void> {
    // Store options for later use when send() or work() is called
    if (options) {
      this.queueOptions.set(name, options);
    }
    // Ensure the BullMQ Queue object is created
    this.getOrCreateQueue(name);
  }

  async schedule(
    name: string,
    cron: string,
    data?: JobData,
    options?: ScheduleOptions,
  ): Promise<void> {
    const q = this.getOrCreateQueue(name);

    // Build job options from schedule options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobOpts: Record<string, any> = {};
    if (options?.retryLimit) {
      jobOpts.attempts = options.retryLimit + 1;
      jobOpts.backoff = options.retryBackoff
        ? { type: 'exponential', delay: (options.retryDelay ?? 1) * 1000 }
        : { type: 'fixed', delay: (options.retryDelay ?? 1) * 1000 };
    }
    if (options?.expireInSeconds) {
      jobOpts.timeout = options.expireInSeconds * 1000;
    }

    // Use upsertJobScheduler for repeatable cron jobs (BullMQ v4+)
    await q.upsertJobScheduler(
      name, // scheduler key
      { pattern: cron },
      {
        name,
        data: data ?? {},
        opts: jobOpts,
      },
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private getOrCreateQueue(name: string): BullQueue {
    let q = this.queues.get(name);
    if (!q) {
      const { Queue } = this.bullmq;
      q = new Queue(name, { connection: this.connectionOpts });
      this.queues.set(name, q);
    }
    return q;
  }
}
