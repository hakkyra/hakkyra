/**
 * Event trigger manager.
 *
 * Orchestrates the full event trigger lifecycle:
 * 1. Create the internal schema and event_log table
 * 2. Install PG triggers on tables with event trigger configs
 * 3. Start pg-listen subscriber for NOTIFY signals
 * 4. Register pg-boss workers for webhook delivery
 * 5. Catchup: enqueue any pending events from previous runs
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import createSubscriber from 'pg-listen';
import type { TableInfo } from '../types.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import type { ServiceManager } from '../shared/service-manager.js';
import { ensureEventSchema } from './schema.js';
import { enqueuePendingEvents, registerEventWorkers } from './delivery.js';
import { reconcileTriggers, buildDesiredEventTriggers } from '../shared/trigger-reconciler.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** @deprecated Use ServiceManager instead. Kept for backwards compatibility. */
export type EventManager = ServiceManager;

// ─── Initialization ────────────────────────────────────────────────────────

export interface EventTriggerOptions {
  /** Batch size for fetching pending events (default: 100). */
  batchSize?: number;
  /** Internal schema name (default: 'hakkyra'). */
  schemaName?: string;
  /** Default concurrency for event webhook delivery per trigger (default: 1). */
  httpConcurrency?: number;
}

export interface EventManagerDeps {
  pool: Pool;
  jobQueue: JobQueue;
  tables: TableInfo[];
  connectionString: string;
  logger: Logger;
  options?: EventTriggerOptions;
}

/**
 * Create an EventManager that conforms to the ServiceManager interface.
 */
export function createEventManager(deps: EventManagerDeps): ServiceManager {
  const { pool, jobQueue, tables, logger, options } = deps;
  const connectionString = deps.connectionString;
  const schemaName = options?.schemaName ?? 'hakkyra';
  const batchSize = options?.batchSize;

  // pg-listen subscriber, created during init, closed during stop
  let subscriber: ReturnType<typeof createSubscriber> | undefined;

  return {
    async init(): Promise<void> {
      const channelName = `${schemaName}_events`;
      const tablesWithEvents = tables.filter((t) => t.eventTriggers.length > 0);

      if (tablesWithEvents.length === 0) {
        logger.info('No event triggers configured');
        return;
      }

      // 1. Ensure schema and event_log table
      await ensureEventSchema(pool, schemaName);
      logger.info('Event log schema ready');

      // 2. Reconcile PG triggers (diff-based: only create/drop/replace what changed)
      const desiredEventTriggers = buildDesiredEventTriggers(tablesWithEvents, schemaName);
      const reconcileResult = await reconcileTriggers(pool, desiredEventTriggers, logger, {
        triggerPrefix: `${schemaName}_event_`,
        schemaName,
      });
      logger.info(
        {
          tables: tablesWithEvents.map((t) => `${t.schema}.${t.name}`),
          created: reconcileResult.created.length,
          dropped: reconcileResult.dropped.length,
          replaced: reconcileResult.replaced.length,
          unchanged: reconcileResult.unchanged.length,
        },
        'Event triggers reconciled',
      );

      // 3. Register job queue workers
      await registerEventWorkers(jobQueue, pool, tables, logger, schemaName, options?.httpConcurrency);

      // 4. Start pg-listen subscriber
      subscriber = createSubscriber({ connectionString });

      subscriber.notifications.on(channelName, async () => {
        try {
          await enqueuePendingEvents(pool, jobQueue, logger, batchSize, schemaName);
        } catch (err) {
          logger.error({ err }, 'Error processing event notification');
        }
      });

      subscriber.events.on('error', (err) => {
        logger.error({ err }, 'pg-listen error');
      });

      await subscriber.connect();
      await subscriber.listenTo(channelName);
      logger.info('Event listener connected');

      // 5. Catchup: process any pending events from before startup
      const catchupCount = await enqueuePendingEvents(pool, jobQueue, logger, batchSize, schemaName);
      if (catchupCount > 0) {
        logger.info({ count: catchupCount }, 'Caught up pending events');
      }

      const triggerCount = tablesWithEvents.reduce((sum, t) => sum + t.eventTriggers.length, 0);
      logger.info(
        { triggers: triggerCount, tables: tablesWithEvents.length },
        'Event trigger system initialized',
      );
    },

    async stop(): Promise<void> {
      if (subscriber) {
        await subscriber.close();
        subscriber = undefined;
      }
    },
  };
}

/**
 * Initialize the event trigger system.
 *
 * @deprecated Use createEventManager() + manager.init() instead.
 * Kept for backwards compatibility with existing code.
 *
 * @param pool - Primary database connection pool
 * @param jobQueue - Job queue instance (must already be started)
 * @param tables - All tracked tables (only those with eventTriggers are processed)
 * @param connectionString - Connection string for pg-listen
 * @param logger - Pino logger instance
 * @returns An EventManager for lifecycle control
 */
export async function initEventTriggers(
  pool: Pool,
  jobQueue: JobQueue,
  tables: TableInfo[],
  connectionString: string,
  logger: Logger,
  options?: EventTriggerOptions,
): Promise<ServiceManager> {
  const manager = createEventManager({
    pool,
    jobQueue,
    tables,
    connectionString,
    logger,
    options,
  });
  await manager.init();
  return manager;
}
