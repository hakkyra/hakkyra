/**
 * pg-boss adapter for the JobQueue interface.
 *
 * Wraps pg-boss to match the abstract JobQueue contract, preserving all
 * existing behavior: schema isolation, auto-migration,
 * and supervised mode.
 */

import { PgBoss } from 'pg-boss';
import type { Job as PgBossJob } from 'pg-boss';
import type {
  JobQueue,
  JobData,
  JobHandler,
  Job,
  QueueOptions,
  ScheduleOptions,
} from './types.js';

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export class PgBossAdapter implements JobQueue {
  private boss: PgBoss;
  private gracefulShutdownMs: number;

  constructor(connectionString: string, gracefulShutdownMs: number = 10000, schemaName: string = 'hakkyra') {
    this.gracefulShutdownMs = gracefulShutdownMs;
    this.boss = new PgBoss({
      connectionString,
      schema: `${schemaName}_boss`,
      migrate: true,
      supervise: true,
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: this.gracefulShutdownMs });
  }

  async send<T extends JobData>(queue: string, data: T): Promise<string | null> {
    return this.boss.send(queue, data);
  }

  async work<T extends JobData>(queue: string, handler: JobHandler<T>): Promise<void> {
    await this.boss.work<T>(queue, async (pgBossJobs: PgBossJob<T>[]) => {
      // Map pg-boss Job objects to our abstract Job type
      const jobs: Job<T>[] = pgBossJobs.map((j) => ({
        id: j.id,
        name: j.name,
        data: j.data,
      }));
      await handler(jobs);
    });
  }

  async createQueue(name: string, options?: QueueOptions): Promise<void> {
    await this.boss.createQueue(name, options ? stripUndefined(options) : {});
  }

  async schedule(
    name: string,
    cron: string,
    data?: JobData,
    options?: ScheduleOptions,
  ): Promise<void> {
    await this.boss.schedule(name, cron, data ?? {}, options ? stripUndefined(options) : {});
  }
}
