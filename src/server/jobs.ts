/**
 * Job queue, event triggers, cron triggers, async actions, and subscription wiring.
 *
 * Phase 2 features that are initialized after the Fastify + Mercurius core
 * is ready. Each sub-system is independently try/caught so one failure does
 * not block the others.
 *
 * All background services (events, crons, async actions) conform to the
 * ServiceManager interface for uniform init/stop lifecycle management.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { HakkyraConfig, TableInfo } from '../types.js';
import type { ConnectionManager } from '../connections/manager.js';
import { createJobQueue } from '../shared/job-queue/index.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import type { ServiceManager } from '../shared/service-manager.js';
import { createCronManager } from '../crons/manager.js';
import { createEventManager } from '../events/manager.js';
import { createActionManager } from '../actions/manager.js';
import { registerEventCleanup } from '../events/cleanup.js';
import { reconcileTriggers, buildDesiredSubscriptionTriggers } from '../shared/trigger-reconciler.js';
import { createChangeListener } from '../subscriptions/listener.js';
import type { ChangeListener } from '../subscriptions/listener.js';
import { createSubscriptionManager } from '../subscriptions/manager.js';
import type { SubscriptionManager } from '../subscriptions/manager.js';
import { createRedisFanoutBridge } from '../subscriptions/redis-fanout.js';
import type { RedisFanoutBridge } from '../subscriptions/redis-fanout.js';
import { registerInvokeRoute } from '../events/invoke.js';
import { registerAsyncActionStatusRoute } from '../actions/rest.js';
import type { Logger } from 'pino';
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
  eventManager: ServiceManager | undefined;
  cronManager: ServiceManager | undefined;
  actionManager: ServiceManager | undefined;
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
  let eventManager: ServiceManager | undefined;
  let cronManager: ServiceManager | undefined;
  let actionManager: ServiceManager | undefined;
  let changeListener: ChangeListener | undefined;
  let subscriptionMgr: SubscriptionManager | undefined;
  let redisFanout: RedisFanoutBridge | undefined;

  // FastifyBaseLogger is a compatible subset of pino.Logger — safe upcast
  const log = server.log as unknown as Logger;

  if (!primaryConnectionString) {
    server.log.warn(
      `Database URL env var "${primaryUrlEnv}" not set — skipping Phase 2 features (events, crons, subscriptions)`,
    );
    return { jobQueue, eventManager, cronManager, actionManager, changeListener, subscriptionMgr, redisFanout };
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

  // Initialize events + crons via ServiceManager interface
  if (jobQueue) {
    try {
      cronManager = createCronManager({
        jobQueue,
        triggers: config.cronTriggers,
        logger: log,
      });
      await cronManager.init();

      eventManager = createEventManager({
        pool: primaryPool,
        jobQueue,
        tables,
        connectionString: sessionConnectionString,
        logger: log,
        options: { batchSize: config.eventDelivery.batchSize, schemaName, httpConcurrency: config.eventDelivery.httpConcurrency },
      });
      await eventManager.init();

      await registerEventCleanup(jobQueue, primaryPool, config.eventLogRetentionDays, log, {
        schedule: config.eventCleanup.schedule,
        schemaName,
      });
    } catch (err) {
      server.log.warn({ err }, 'Event/cron initialization failed — continuing without');
      eventManager = undefined;
      cronManager = undefined;
    }

    // Async action initialization via ServiceManager interface
    try {
      const asyncActions = config.actions.filter((a) => a.definition.kind === 'asynchronous');
      if (asyncActions.length > 0) {
        actionManager = createActionManager({
          jobQueue,
          pool: primaryPool,
          actions: config.actions,
          logger: log,
        });
        await actionManager.init();
        asyncActionRef.jobQueue = jobQueue;
        asyncActionRef.pool = primaryPool;
      }
    } catch (err) {
      server.log.warn({ err }, 'Async action initialization failed — continuing without');
      actionManager = undefined;
    }
  }

  // Manual event invocation route
  registerInvokeRoute(server, {
    pool: primaryPool,
    jobQueue,
    tables,
  });

  // Async action status REST endpoint
  registerAsyncActionStatusRoute(server, {
    pool: primaryPool,
    actions: config.actions,
  });

  // Subscriptions
  try {
    const desiredSubTriggers = buildDesiredSubscriptionTriggers(tables, schemaName);
    const subReconcile = await reconcileTriggers(
      primaryPool,
      desiredSubTriggers,
      server.log as unknown as Logger,
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

  return { jobQueue, eventManager, cronManager, actionManager, changeListener, subscriptionMgr, redisFanout };
}
