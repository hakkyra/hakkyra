/**
 * pg-boss adapter for the JobQueue interface.
 *
 * Wraps pg-boss to match the abstract JobQueue contract, preserving all
 * existing behavior: schema isolation (hakkyra_boss), auto-migration,
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

export class PgBossAdapter implements JobQueue {
  private boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss({
      connectionString,
      schema: 'hakkyra_boss',
      migrate: true,
      supervise: true,
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10000 });
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
    await this.boss.createQueue(name, {
      retryLimit: options?.retryLimit,
      retryDelay: options?.retryDelay,
      retryBackoff: options?.retryBackoff,
      expireInSeconds: options?.expireInSeconds,
    });
  }

  async schedule(
    name: string,
    cron: string,
    data?: JobData,
    options?: ScheduleOptions,
  ): Promise<void> {
    await this.boss.schedule(name, cron, data ?? {}, {
      retryLimit: options?.retryLimit,
      retryDelay: options?.retryDelay,
      retryBackoff: options?.retryBackoff,
      expireInSeconds: options?.expireInSeconds,
    });
  }
}
