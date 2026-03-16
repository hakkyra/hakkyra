/**
 * Job queue, event triggers, cron triggers, async actions, and subscription wiring.
 *
 * Phase 2 features that are initialized after the Fastify + Mercurius core
 * is ready. Each sub-system is independently try/caught so one failure does
 * not block the others.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { HakkyraConfig, TableInfo } from '../types.js';
import type { ConnectionManager } from '../connections/manager.js';
import { createJobQueue } from '../shared/job-queue/index.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import { initCronTriggers } from '../crons/index.js';
import { initEventTriggers } from '../events/manager.js';
import type { EventManager } from '../events/manager.js';
import { registerEventCleanup } from '../events/cleanup.js';
import { reconcileTriggers, buildDesiredSubscriptionTriggers } from '../shared/trigger-reconciler.js';
import { createChangeListener } from '../subscriptions/listener.js';
import type { ChangeListener } from '../subscriptions/listener.js';
import { createSubscriptionManager } from '../subscriptions/manager.js';
import type { SubscriptionManager } from '../subscriptions/manager.js';
import { createRedisFanoutBridge } from '../subscriptions/redis-fanout.js';
import type { RedisFanoutBridge } from '../subscriptions/redis-fanout.js';
import { ensureAsyncActionSchema, registerAsyncActionWorkers } from '../actions/index.js';
import { registerInvokeRoute } from '../events/invoke.js';
import { registerAsyncActionStatusRoute } from '../actions/rest.js';
import type { SubscriptionRef, AsyncActionRef } from './context.js';

// ─── Phase 2 initialization ─────────────────────────────────────────────────

export interface Phase2Deps {
  server: FastifyInstance;
  config: HakkyraConfig;
  connectionManager: ConnectionManager;
  primaryPool: Pool;
  tables: TableInfo[];
  schemaName: string;
  subscriptionRef: SubscriptionRef;
  asyncActionRef: AsyncActionRef;
}

export interface Phase2Result {
  jobQueue: JobQueue | undefined;
  eventManager: EventManager | undefined;
  changeListener: ChangeListener | undefined;
  subscriptionMgr: SubscriptionManager | undefined;
  redisFanout: RedisFanoutBridge | undefined;
}

/**
 * Initialize all Phase 2 features: job queue, events, crons, async actions,
 * and subscriptions. Returns handles needed for graceful shutdown.
 */
export async function initPhase2(deps: Phase2Deps): Promise<Phase2Result> {
  const {
    server,
    config,
    connectionManager,
    primaryPool,
    tables,
    schemaName,
    subscriptionRef,
    asyncActionRef,
  } = deps;

  const primaryUrlEnv = config.databases.primary.urlEnv;
  const primaryConnectionString = process.env[primaryUrlEnv] ?? '';
  const sessionConnectionString = connectionManager.getSessionConnectionString();

  let jobQueue: JobQueue | undefined;
  let eventManager: EventManager | undefined;
  let changeListener: ChangeListener | undefined;
  let subscriptionMgr: SubscriptionManager | undefined;
  let redisFanout: RedisFanoutBridge | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = server.log as any;

  if (!primaryConnectionString) {
    server.log.warn(
      `Database URL env var "${primaryUrlEnv}" not set — skipping Phase 2 features (events, crons, subscriptions)`,
    );
    return { jobQueue, eventManager, changeListener, subscriptionMgr, redisFanout };
  }

  try {
    // Start job queue (shared by events, crons, and async actions)
    const jqConf = config.jobQueue;
    jobQueue = await createJobQueue({
      provider: jqConf?.provider ?? 'pg-boss',
      connectionString: jqConf?.connectionString ?? primaryConnectionString,
      redis: jqConf?.redis,
      gracefulShutdownMs: jqConf?.gracefulShutdownMs,
      schemaName,
    });
    await jobQueue.start();
    server.log.info({ provider: jqConf?.provider ?? 'pg-boss' }, 'Job queue started');
  } catch (err) {
    server.log.warn({ err }, 'Job queue initialization failed — continuing without Phase 2 features');
  }

  // Initialize events + crons (separate try/catch so failures don't block async actions)
  if (jobQueue) {
    try {
      await initCronTriggers(jobQueue, config.cronTriggers, log);

      eventManager = await initEventTriggers(
        primaryPool,
        jobQueue,
        tables,
        sessionConnectionString,
        log,
        { batchSize: config.eventDelivery.batchSize, schemaName, httpConcurrency: config.eventDelivery.httpConcurrency },
      );

      await registerEventCleanup(jobQueue, primaryPool, config.eventLogRetentionDays, log, {
        schedule: config.eventCleanup.schedule,
        schemaName,
      });
    } catch (err) {
      server.log.warn({ err }, 'Event/cron initialization failed — continuing without');
      eventManager = undefined;
    }

    // Async action initialization (independent from events/crons)
    try {
      const asyncActions = config.actions.filter((a) => a.definition.kind === 'asynchronous');
      if (asyncActions.length > 0) {
        await ensureAsyncActionSchema(primaryPool);
        await registerAsyncActionWorkers(jobQueue, primaryPool, config.actions, log);
        asyncActionRef.jobQueue = jobQueue;
        asyncActionRef.pool = primaryPool;
        server.log.info({ count: asyncActions.length }, 'Async action system initialized');
      }
    } catch (err) {
      server.log.warn({ err }, 'Async action initialization failed — continuing without');
    }
  }

  // Manual event invocation route
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerInvokeRoute(server as any, {
    pool: primaryPool,
    jobQueue,
    tables,
  });

  // Async action status REST endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAsyncActionStatusRoute(server as any, {
    pool: primaryPool,
  });

  // Subscriptions
  try {
    const desiredSubTriggers = buildDesiredSubscriptionTriggers(tables, schemaName);
    const subReconcile = await reconcileTriggers(
      primaryPool,
      desiredSubTriggers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.log as any,
      { triggerPrefix: `${schemaName}_notify_`, schemaName },
    );
    server.log.info(
      {
        created: subReconcile.created.length,
        dropped: subReconcile.dropped.length,
        replaced: subReconcile.replaced.length,
        unchanged: subReconcile.unchanged.length,
      },
      'Subscription triggers reconciled',
    );

    changeListener = createChangeListener(sessionConnectionString, schemaName);
    subscriptionMgr = createSubscriptionManager(connectionManager, log, {
      queryRouting: config.databases.subscriptionQueryRouting ?? 'primary',
      debounceMs: config.subscriptions.debounceMs,
    });

    subscriptionRef.manager = subscriptionMgr;

    // Set up the notification pipeline
    if (config.redis) {
      try {
        redisFanout = await createRedisFanoutBridge(config.redis, log);

        changeListener.onTableChange((notification) => {
          subscriptionMgr!.handleChange(notification).catch((err) => {
            server.log.error({ err }, 'Error handling subscription change');
          });
          redisFanout!.publish(notification).catch((err) => {
            server.log.error({ err }, 'Error publishing to Redis fanout');
          });
        });

        redisFanout.onRemoteChange((notification) => {
          subscriptionMgr!.handleChange(notification).catch((err) => {
            server.log.error({ err }, 'Error handling remote subscription change');
          });
        });

        await redisFanout.start();
        server.log.info('Multi-instance subscription fanout via Redis enabled');
      } catch (err) {
        server.log.warn({ err }, 'Redis fanout initialization failed — falling back to single-instance mode');
        redisFanout = undefined;

        changeListener.onTableChange((notification) => {
          subscriptionMgr!.handleChange(notification).catch((err2) => {
            server.log.error({ err: err2 }, 'Error handling subscription change');
          });
        });
      }
    } else {
      changeListener.onTableChange((notification) => {
        subscriptionMgr!.handleChange(notification).catch((err) => {
          server.log.error({ err }, 'Error handling subscription change');
        });
      });
    }

    await changeListener.start();
    server.log.info('Subscription change listener started');
  } catch (err) {
    server.log.warn({ err }, 'Subscription initialization failed — continuing without');
    changeListener = undefined;
    subscriptionMgr = undefined;
  }

  return { jobQueue, eventManager, changeListener, subscriptionMgr, redisFanout };
}
