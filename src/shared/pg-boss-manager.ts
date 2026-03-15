/**
 * pg-boss lifecycle manager.
 *
 * Provides a shared pg-boss instance for event triggers and cron triggers.
 * Handles initialization, start, and graceful shutdown.
 */

import { PgBoss } from 'pg-boss';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PgBossManager {
  boss: PgBoss;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a pg-boss manager connected to the primary database.
 *
 * Uses `${schemaName}_boss` schema to isolate pg-boss tables from the application schema.
 * Auto-creates required tables on startup via `migrate: true`.
 */
export function createPgBossManager(
  connectionString: string,
  gracefulShutdownMs: number = 10000,
  schemaName: string = 'hakkyra',
): PgBossManager {
  const boss = new PgBoss({
    connectionString,
    schema: `${schemaName}_boss`,
    migrate: true,
    supervise: true,
  });

  return {
    boss,

    async start(): Promise<void> {
      await boss.start();
    },

    async stop(): Promise<void> {
      await boss.stop({ graceful: true, timeout: gracefulShutdownMs });
    },
  };
}
