/**
 * Scheduled event manager: ensures the schema and runs the delivery poller.
 *
 * Runs independently of the job queue — one-off scheduled events use their
 * own table-based retry state (Hasura-style), so they work even when the
 * job queue is unavailable.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ServiceManager } from '../shared/service-manager.js';
import { ensureScheduledEventSchema } from './schema.js';
import { processDueScheduledEvents } from './delivery.js';

export interface ScheduledEventManagerDeps {
  pool: Pool;
  logger: Logger;
  schemaName?: string;
  /** How often to poll for due events (ms). Default 10000 (Hasura polls every 10s). */
  pollIntervalMs?: number;
  /** Max events claimed per poll. Default 100. */
  batchSize?: number;
}

export function createScheduledEventManager(deps: ScheduledEventManagerDeps): ServiceManager {
  const schemaName = deps.schemaName ?? 'hakkyra';
  const pollIntervalMs = deps.pollIntervalMs ?? 10000;
  const batchSize = deps.batchSize ?? 100;
  const { pool, logger } = deps;

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let ticking = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    inFlight = (async () => {
      try {
        await processDueScheduledEvents(pool, schemaName, batchSize, logger);
      } catch (err) {
        logger.error({ err }, 'Scheduled event poll failed');
      } finally {
        ticking = false;
      }
    })();
    await inFlight;
  }

  return {
    async init(): Promise<void> {
      await ensureScheduledEventSchema(pool, schemaName);
      // Immediate catch-up pass, then poll on the interval
      await tick();
      timer = setInterval(() => void tick(), pollIntervalMs);
      // Don't keep the process alive just for the poller
      timer.unref?.();
      logger.info({ pollIntervalMs }, 'Scheduled event poller started');
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      await inFlight;
      logger.info('Scheduled event poller stopped');
    },
  };
}
