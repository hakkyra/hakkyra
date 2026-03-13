/**
 * Main server factory.
 *
 * Creates and configures a Fastify instance with:
 * - Mercurius GraphQL plugin with the generated schema
 * - Auth preHandler hook
 * - REST API routes
 * - Health / readiness endpoints
 * - Graceful shutdown
 */

import { createRequire } from 'node:module';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';
import { printSchema } from 'graphql';
import type { HakkyraConfig, TableInfo, CompiledPermission, SchemaModel } from './types.js';
import { createConnectionManager } from './connections/manager.js';
import type { ConnectionManager } from './connections/manager.js';
import { introspectDatabase } from './introspection/introspector.js';
import { mergeSchemaModel } from './introspection/merger.js';
import { buildPermissionLookup } from './permissions/lookup.js';
import type { PermissionLookup } from './permissions/lookup.js';
import { generateSchema } from './schema/generator.js';
import { createAuthHook } from './auth/middleware.js';
import { registerRESTRoutes } from './rest/router.js';
import type { RESTRouterDeps } from './rest/router.js';
import { generateOpenAPISpec } from './docs/openapi.js';
import { generateLLMDoc } from './docs/llm-format.js';
import { generateGraphQLSDL } from './docs/graphql-sdl.js';
import { createQueryCache } from './sql/cache.js';
import type { QueryCache } from './sql/cache.js';
import { createConfigWatcher } from './config/watcher.js';
import type { ConfigWatcher } from './config/watcher.js';
import { loadConfig } from './config/loader.js';
import { createJobQueue } from './shared/job-queue/index.js';
import type { JobQueue } from './shared/job-queue/types.js';
import { initCronTriggers } from './crons/index.js';
import { initEventTriggers } from './events/manager.js';
import type { EventManager } from './events/manager.js';
import { registerEventCleanup } from './events/cleanup.js';
import { installSubscriptionTriggers } from './subscriptions/triggers.js';
import { createChangeListener } from './subscriptions/listener.js';
import type { ChangeListener } from './subscriptions/listener.js';
import { createSubscriptionManager } from './subscriptions/manager.js';
import type { SubscriptionManager } from './subscriptions/manager.js';
import type { ResolverPermissionLookup } from './schema/resolvers.js';
import { authenticateWsConnection } from './auth/ws-auth.js';
import { registerInvokeRoute } from './events/invoke.js';
import { ensureAsyncActionSchema, registerAsyncActionWorkers } from './actions/index.js';
import { registerAsyncActionStatusRoute } from './actions/rest.js';

// ─── Permission adapters ─────────────────────────────────────────────────────

/**
 * Create a permission getter function compatible with RESTRouterDeps.
 */
function createPermissionGetter(
  lookup: PermissionLookup,
): (table: TableInfo, role: string) => CompiledPermission | undefined {
  return (table: TableInfo, role: string): CompiledPermission | undefined => {
    const result = lookup.get(table.name, table.schema, role, 'select');
    return result ?? undefined;
  };
}

/**
 * Adapt the generic PermissionLookup (which uses .get(table, schema, role, operation))
 * into the resolver-specific ResolverPermissionLookup (which exposes per-operation getters
 * returning the specific permission shape for each operation).
 */
function createResolverPermissionLookup(
  lookup: PermissionLookup,
): ResolverPermissionLookup {
  return {
    getSelect(tableSchema, tableName, role) {
      const perm = lookup.get(tableName, tableSchema, role, 'select');
      return perm?.select ?? null;
    },
    getInsert(tableSchema, tableName, role) {
      const perm = lookup.get(tableName, tableSchema, role, 'insert');
      return perm?.insert ?? null;
    },
    getUpdate(tableSchema, tableName, role) {
      const perm = lookup.get(tableName, tableSchema, role, 'update');
      return perm?.update ?? null;
    },
    getDelete(tableSchema, tableName, role) {
      const perm = lookup.get(tableName, tableSchema, role, 'delete');
      return perm?.delete ?? null;
    },
  };
}

// ─── Server Factory ──────────────────────────────────────────────────────────

/**
 * Create and configure the Hakkyra server.
 *
 * Startup sequence:
 * 1. Create connection manager
 * 2. Introspect database
 * 3. Merge introspection with config -> SchemaModel
 * 4. Compile permissions
 * 5. Generate GraphQL schema
 * 6. Create Fastify server
 * 7. Register Mercurius with schema
 * 8. Register auth middleware
 * 9. Register REST routes
 * 10. Return server (caller does `server.listen()`)
 */
export interface ServerOptions {
  /** Enable dev mode with config watcher for hot reload */
  devMode?: boolean;
  /** Path to metadata directory (needed for config watcher) */
  metadataPath?: string;
  /** Path to server config file (needed for config watcher) */
  configPath?: string;
}

export async function createServer(
  config: HakkyraConfig,
  options?: ServerOptions,
): Promise<FastifyInstance> {
  // 1. Create connection manager
  const connectionManager = createConnectionManager(config.databases);

  // 2. Introspect database
  const primaryPool = connectionManager.getPool('write');
  const introspection = await introspectDatabase(primaryPool);

  // 3. Merge introspection with config -> SchemaModel
  const mergeResult = mergeSchemaModel(introspection, config);
  const schemaModel: SchemaModel = mergeResult.model;

  // Log merge warnings
  if (mergeResult.warnings.length > 0) {
    for (const warning of mergeResult.warnings) {
      console.warn(`[hakkyra:schema] ${warning.type}: ${warning.message}`);
    }
  }

  // 4. Compile permissions
  const permissionLookup = buildPermissionLookup(schemaModel.tables);

  // 5. Generate GraphQL schema (with action fields if configured)
  const graphqlSchema = generateSchema(schemaModel, {
    actions: config.actions,
    actionsGraphql: config.actionsGraphql,
  });

  // 6. Create Fastify server
  let transport: { target: string; options: Record<string, unknown> } | undefined;
  if (process.env['NODE_ENV'] !== 'production' && process.env['NODE_ENV'] !== 'test') {
    try {
      await import('pino-pretty');
      transport = { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
    } catch {
      // pino-pretty not installed, use default
    }
  }

  const server = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport,
    },
  });

  // 7. Register auth middleware (must be BEFORE Mercurius so preHandler runs)
  await server.register(createAuthHook(config.auth));

  // 8. Register Mercurius with schema
  // Work around ESM/CJS dual-package hazard: Mercurius does require('graphql')
  // which may create a different module instance than our ESM import, causing
  // instanceof GraphQLSchema to fail. We rebuild the schema using the CJS
  // graphql instance that Mercurius will use, and copy our resolvers over.
  const _require = createRequire(import.meta.url);
  const cjsGraphql = _require('graphql') as typeof import('graphql');
  const sdl = printSchema(graphqlSchema);
  const cjsSchema = cjsGraphql.buildSchema(sdl);

  // Copy resolvers and subscribe functions from our ESM schema to the CJS schema
  const esmTypeMap = graphqlSchema.getTypeMap();
  const cjsTypeMap = cjsSchema.getTypeMap();
  for (const [typeName, cjsType] of Object.entries(cjsTypeMap)) {
    const esmType = esmTypeMap[typeName];
    if (!esmType) continue;
    // Copy field resolvers and subscribe functions for object types
    if ('getFields' in cjsType && 'getFields' in esmType) {
      const cjsFields = (cjsType as import('graphql').GraphQLObjectType).getFields();
      const esmFields = (esmType as import('graphql').GraphQLObjectType).getFields();
      for (const [fieldName, cjsField] of Object.entries(cjsFields)) {
        const esmField = esmFields[fieldName];
        if (esmField?.resolve) {
          cjsField.resolve = esmField.resolve as typeof cjsField.resolve;
        }
        // Copy subscribe functions (needed for subscription fields)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((esmField as any)?.subscribe) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cjsField as any).subscribe = (esmField as any).subscribe;
        }
      }
    }
    // Copy serialize/parseValue/parseLiteral for custom scalars
    if ('serialize' in cjsType && 'serialize' in esmType) {
      const cjsScalar = cjsType as import('graphql').GraphQLScalarType;
      const esmScalar = esmType as import('graphql').GraphQLScalarType;
      cjsScalar.serialize = esmScalar.serialize as typeof cjsScalar.serialize;
      cjsScalar.parseValue = esmScalar.parseValue as typeof cjsScalar.parseValue;
      cjsScalar.parseLiteral = esmScalar.parseLiteral as typeof cjsScalar.parseLiteral;
    }
    // Copy enum internal values (buildSchema loses value mappings from SDL)
    if ('getValues' in cjsType && 'getValues' in esmType) {
      const cjsEnum = cjsType as import('graphql').GraphQLEnumType;
      const esmEnum = esmType as import('graphql').GraphQLEnumType;
      const esmValues = esmEnum.getValues();
      const cjsValues = cjsEnum.getValues();
      for (const cjsVal of cjsValues) {
        const esmVal = esmValues.find(v => v.name === cjsVal.name);
        if (esmVal && esmVal.value !== cjsVal.value) {
          cjsVal.value = esmVal.value;
        }
      }
    }
  }

  // 7b. Build the resolver permission lookup adapter
  const resolverPermissionLookup = createResolverPermissionLookup(permissionLookup);

  // 7c. Create query cache for compiled SQL templates
  const queryCache = createQueryCache(1000);

  // 7d. Mutable references for services initialized after Mercurius registration.
  // The context closure captures these objects by reference.
  const subscriptionRef: { manager: SubscriptionManager | undefined } = { manager: undefined };
  const asyncActionRef: { jobQueue: JobQueue | undefined; pool: typeof primaryPool | undefined } = {
    jobQueue: undefined,
    pool: undefined,
  };

  await server.register(mercurius, {
    schema: cjsSchema,
    graphiql: process.env['NODE_ENV'] !== 'production',
    path: '/graphql',
    context: (request) => {
      // Build the ResolverContext from the authenticated request.
      // The auth preHandler hook has already run by the time the context
      // function executes, so request.session is populated.
      const auth = request.session ?? {
        role: 'anonymous',
        allowedRoles: [],
        isAdmin: false,
        claims: {},
      };
      return {
        auth,
        queryWithSession: (
          sql: string,
          params: unknown[],
          session: typeof auth,
          intent: 'read' | 'write',
        ) => connectionManager.queryWithSession(sql, params, session, intent),
        permissionLookup: resolverPermissionLookup,
        tables: schemaModel.tables,
        functions: schemaModel.functions,
        queryCache,
        subscriptionManager: subscriptionRef.manager,
        jobQueue: asyncActionRef.jobQueue,
        pool: asyncActionRef.pool,
      };
    },
    subscription: {
      keepAlive: 30000,
      async onConnect(data) {
        // Authenticate the WebSocket connection using connectionParams
        const connectionParams = (data?.payload as Record<string, unknown>) ?? {};
        const session = await authenticateWsConnection(connectionParams, config.auth);
        if (!session) {
          // Returning false / throwing rejects the connection
          throw new Error('WebSocket authentication failed');
        }
        // Store session on the context for the subscription context function
        return { session };
      },
      context(_connection, context) {
        // Build ResolverContext for subscription operations.
        // The session was set by onConnect and is available via context.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const connectResult = (context as any)?._connectionInit ?? (context as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = connectResult?.session ?? (context as any)?.session;
        const auth = session ?? {
          role: 'anonymous',
          allowedRoles: [],
          isAdmin: false,
          claims: {},
        };
        return {
          auth,
          queryWithSession: (
            sql: string,
            params: unknown[],
            sess: typeof auth,
            intent: 'read' | 'write',
          ) => connectionManager.queryWithSession(sql, params, sess, intent),
          permissionLookup: resolverPermissionLookup,
          tables: schemaModel.tables,
          functions: schemaModel.functions,
          queryCache,
          subscriptionManager: subscriptionRef.manager,
          jobQueue: asyncActionRef.jobQueue,
          pool: asyncActionRef.pool,
        };
      },
    },
  });

  // 9. Register REST routes
  const routerDeps: RESTRouterDeps = {
    getPool: (intent) => connectionManager.getPool(intent),
    getPermission: createPermissionGetter(permissionLookup),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRESTRoutes(server as any, schemaModel.tables, config.rest, routerDeps);

  // ── Health check endpoint ──────────────────────────────────────────────
  server.get('/healthz', async (_request, reply) => {
    void reply.code(200).send({ status: 'ok' });
  });

  // ── Readiness check endpoint ───────────────────────────────────────────
  server.get('/readyz', async (_request, reply) => {
    const healthy = await connectionManager.healthCheck();
    if (healthy) {
      void reply.code(200).send({ status: 'ok' });
    } else {
      void reply.code(503).send({ status: 'unavailable', message: 'Database connection failed' });
    }
  });

  // ── API documentation endpoints ────────────────────────────────────────
  if (config.apiDocs.generate) {
    const tables = schemaModel.tables;

    // OpenAPI spec endpoint
    server.get('/openapi.json', async (_request, reply) => {
      const spec = generateOpenAPISpec(tables, config.rest);
      void reply.code(200).header('content-type', 'application/json').send(spec);
    });

    // LLM-friendly doc endpoint
    if (config.apiDocs.llmFormat) {
      server.get('/llm-api.json', async (_request, reply) => {
        const doc = generateLLMDoc(tables, config.rest);
        void reply.code(200).header('content-type', 'application/json').send(doc);
      });
    }

    // GraphQL SDL endpoint
    const graphqlSdl = generateGraphQLSDL(graphqlSchema);
    server.get('/sdl', async (_request, reply) => {
      void reply.code(200).header('content-type', 'text/plain; charset=utf-8').send(graphqlSdl);
    });
  }

  // ── Phase 2: job queue, events, crons, subscriptions ────────────────

  // Resolve the primary database connection string for job queue and pg-listen
  const primaryUrlEnv = config.databases.primary.urlEnv;
  const primaryConnectionString = process.env[primaryUrlEnv] ?? '';

  let jobQueue: JobQueue | undefined;
  let eventManager: EventManager | undefined;
  let changeListener: ChangeListener | undefined;
  let subscriptionMgr: SubscriptionManager | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = server.log as any;


  if (primaryConnectionString) {
    try {
      // Start job queue (shared by events, crons, and async actions)
      // Determine provider from config (default: pg-boss)
      const jobQueueConfig = config.jobQueue ?? { provider: 'pg-boss' as const };
      jobQueue = await createJobQueue({
        ...jobQueueConfig,
        connectionString: jobQueueConfig.connectionString ?? primaryConnectionString,
      });
      await jobQueue.start();
      server.log.info({ provider: jobQueueConfig.provider ?? 'pg-boss' }, 'Job queue started');
    } catch (err) {
      server.log.warn({ err }, 'Job queue initialization failed — continuing without Phase 2 features');
    }

    // Initialize events + crons (separate try/catch so failures don't block async actions)
    if (jobQueue) {
      try {
        // Initialize cron triggers
        await initCronTriggers(jobQueue, config.cronTriggers, log);

        // Initialize event triggers
        eventManager = await initEventTriggers(
          primaryPool,
          jobQueue,
          schemaModel.tables,
          primaryConnectionString,
          log,
        );

        // Register event log cleanup
        await registerEventCleanup(jobQueue, primaryPool, 7, log);
      } catch (err) {
        server.log.warn({ err }, 'Event/cron initialization failed — continuing without');
        eventManager = undefined;
      }

      // ── Async action initialization (independent from events/crons) ─────
      try {
        const asyncActions = config.actions.filter((a) => a.definition.kind === 'asynchronous');
        if (asyncActions.length > 0) {
          await ensureAsyncActionSchema(primaryPool);
          await registerAsyncActionWorkers(jobQueue, primaryPool, config.actions, log);
          // Populate the mutable ref so resolver contexts pick up the services
          asyncActionRef.jobQueue = jobQueue;
          asyncActionRef.pool = primaryPool;
          server.log.info({ count: asyncActions.length }, 'Async action system initialized');
        }
      } catch (err) {
        server.log.warn({ err }, 'Async action initialization failed — continuing without');
      }
    }

    // ── Manual event invocation route ─────────────────────────────────────
    registerInvokeRoute(server as any, {
      pool: primaryPool,
      jobQueue,
      tables: schemaModel.tables,
    });

    // ── Async action status REST endpoint ─────────────────────────────────
    registerAsyncActionStatusRoute(server as any, {
      pool: primaryPool,
    });

    try {

      // Install subscription notification triggers
      await installSubscriptionTriggers(primaryPool, schemaModel.tables);

      server.log.info('Subscription triggers installed');

      // Create change listener for subscriptions
      changeListener = createChangeListener(primaryConnectionString);
      subscriptionMgr = createSubscriptionManager(connectionManager, log);

      // Make the subscription manager available to resolver contexts
      subscriptionRef.manager = subscriptionMgr;

      changeListener.onTableChange((notification) => {
        subscriptionMgr!.handleChange(notification).catch((err) => {
          server.log.error({ err }, 'Error handling subscription change');
        });
      });

      await changeListener.start();
      server.log.info('Subscription change listener started');
    } catch (err) {

      server.log.warn({ err }, 'Subscription initialization failed — continuing without');
      changeListener = undefined;
      subscriptionMgr = undefined;
    }
  } else {
    server.log.warn(
      `Database URL env var "${primaryUrlEnv}" not set — skipping Phase 2 features (events, crons, subscriptions)`,
    );
  }

  // ── Dev mode config watcher ──────────────────────────────────────────
  let configWatcher: ConfigWatcher | undefined;
  if (options?.devMode && options.metadataPath) {
    configWatcher = createConfigWatcher({
      metadataDir: options.metadataPath,
      serverConfigPath: options.configPath,
      debounceMs: 500,
    });

    configWatcher.on('change', async (files: string[]) => {
      server.log.info({ files }, 'Config changed, reloading schema...');
      try {
        const newConfig = await loadConfig(options.metadataPath!, options.configPath);
        const newIntrospection = await introspectDatabase(primaryPool);
        const newMerge = mergeSchemaModel(newIntrospection, newConfig);
        const newPermLookup = buildPermissionLookup(newMerge.model.tables);
        const newSchema = generateSchema(newMerge.model, {
          actions: newConfig.actions,
          actionsGraphql: newConfig.actionsGraphql,
        });

        // Rebuild the CJS schema for Mercurius
        const newSdl = printSchema(newSchema);
        const newCjsSchema = cjsGraphql.buildSchema(newSdl);

        // Copy resolvers and subscribe functions from new ESM schema to new CJS schema
        const newEsmTypeMap = newSchema.getTypeMap();
        const newCjsTypeMap = newCjsSchema.getTypeMap();
        for (const [typeName, newCjsType] of Object.entries(newCjsTypeMap)) {
          const newEsmType = newEsmTypeMap[typeName];
          if (!newEsmType) continue;
          if ('getFields' in newCjsType && 'getFields' in newEsmType) {
            const cjsFields = (newCjsType as import('graphql').GraphQLObjectType).getFields();
            const esmFields = (newEsmType as import('graphql').GraphQLObjectType).getFields();
            for (const [fieldName, cjsField] of Object.entries(cjsFields)) {
              const esmField = esmFields[fieldName];
              if (esmField?.resolve) {
                cjsField.resolve = esmField.resolve as typeof cjsField.resolve;
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if ((esmField as any)?.subscribe) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (cjsField as any).subscribe = (esmField as any).subscribe;
              }
            }
          }
          if ('serialize' in newCjsType && 'serialize' in newEsmType) {
            const cjsScalar = newCjsType as import('graphql').GraphQLScalarType;
            const esmScalar = newEsmType as import('graphql').GraphQLScalarType;
            cjsScalar.serialize = esmScalar.serialize as typeof cjsScalar.serialize;
            cjsScalar.parseValue = esmScalar.parseValue as typeof cjsScalar.parseValue;
            cjsScalar.parseLiteral = esmScalar.parseLiteral as typeof cjsScalar.parseLiteral;
          }
          if ('getValues' in newCjsType && 'getValues' in newEsmType) {
            const cjsEnum = newCjsType as import('graphql').GraphQLEnumType;
            const esmEnum = newEsmType as import('graphql').GraphQLEnumType;
            for (const cjsVal of cjsEnum.getValues()) {
              const esmVal = esmEnum.getValues().find(v => v.name === cjsVal.name);
              if (esmVal && esmVal.value !== cjsVal.value) cjsVal.value = esmVal.value;
            }
          }
        }

        // Replace schema in Mercurius
        server.graphql.replaceSchema(newCjsSchema);

        // Update permission lookup
        const newResolverPL = createResolverPermissionLookup(newPermLookup);
        Object.assign(resolverPermissionLookup, newResolverPL);

        // Clear query cache on schema change
        queryCache.clear();

        server.log.info('Schema reloaded successfully');
        server.log.info('Note: REST route changes require a server restart');
      } catch (err) {
        server.log.error({ err }, 'Failed to reload config');
      }
    });

    configWatcher.on('error', (err) => {
      server.log.warn({ err }, 'Config watcher error');
    });

    configWatcher.start();
    server.log.info('Dev mode: watching config files for changes');
  }

  // ── Graceful shutdown handler ──────────────────────────────────────────
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'Received shutdown signal');
    try {
      configWatcher?.stop();
      await changeListener?.stop();
      await eventManager?.stop();
      await jobQueue?.stop();
      await server.close();
      await connectionManager.shutdown();
      server.log.info('Server shut down gracefully');
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Decorate server with references for testing/extension
  server.decorate('connectionManager', connectionManager);
  server.decorate('permissionLookup', permissionLookup);
  server.decorate('trackedTables', schemaModel.tables);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return server as any;
}

// ─── Fastify augmentation ────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    connectionManager: ConnectionManager;
    permissionLookup: PermissionLookup;
    trackedTables: TableInfo[];
  }
}
