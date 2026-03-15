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
import { mergeSchemaModel, resolveTableEnums } from './introspection/merger.js';
import { buildPermissionLookup } from './permissions/lookup.js';
import type { PermissionLookup } from './permissions/lookup.js';
import { generateSchema } from './schema/generator.js';
import { resetComparisonTypeCache } from './schema/filters.js';
import { createAuthHook } from './auth/middleware.js';
import { registerRESTRoutes } from './rest/router.js';
import type { RESTRouterDeps } from './rest/router.js';
import { registerHasuraRestEndpoints } from './rest/hasura-endpoints.js';
import type { HasuraRestDeps } from './rest/hasura-endpoints.js';
import { generateOpenAPISpec } from './docs/openapi.js';
import { generateLLMDoc } from './docs/llm-format.js';
import { generateGraphQLSDL } from './docs/graphql-sdl.js';
import { filterTablesForRole } from './docs/role-filter.js';
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
import { reconcileTriggers, buildDesiredSubscriptionTriggers } from './shared/trigger-reconciler.js';
import { createChangeListener } from './subscriptions/listener.js';
import type { ChangeListener } from './subscriptions/listener.js';
import { createSubscriptionManager } from './subscriptions/manager.js';
import type { SubscriptionManager } from './subscriptions/manager.js';
import { createRedisFanoutBridge } from './subscriptions/redis-fanout.js';
import type { RedisFanoutBridge } from './subscriptions/redis-fanout.js';
import type { ResolverPermissionLookup } from './schema/resolvers.js';
import { authenticateWsConnection } from './auth/ws-auth.js';
import { registerInvokeRoute } from './events/invoke.js';
import { ensureAsyncActionSchema, registerAsyncActionWorkers } from './actions/index.js';
import { registerAsyncActionStatusRoute } from './actions/rest.js';
import { CONFIG_DEFAULTS } from './config/schemas-internal.js';
import { configureStringifyNumericTypes } from './introspection/type-map.js';
import { configureWebhookDefaults } from './shared/webhook.js';

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
  const schemaName = config.server.schemaName;
  const connectionManager = createConnectionManager(config.databases, undefined, schemaName);

  // 2. Introspect database
  // Detect all schemas referenced by tracked functions so non-public schemas
  // (e.g. "utils") are included in introspection alongside "public".
  const primaryPool = connectionManager.getPool('write');
  const schemas = new Set<string>(['public']);
  if (config.trackedFunctions) {
    for (const fn of config.trackedFunctions) {
      if (fn.schema) schemas.add(fn.schema);
    }
  }
  const introspection = await introspectDatabase(primaryPool, [...schemas]);

  // 3. Merge introspection with config -> SchemaModel
  const mergeResult = mergeSchemaModel(introspection, config);
  const schemaModel: SchemaModel = mergeResult.model;

  // 3b. Resolve table-based enums (is_enum: true)
  await resolveTableEnums(schemaModel, primaryPool);

  // Log merge warnings
  if (mergeResult.warnings.length > 0) {
    for (const warning of mergeResult.warnings) {
      console.warn(`[hakkyra:schema] ${warning.type}: ${warning.message}`);
    }
  }

  // 4. Compile permissions (with inherited role expansion)
  const permissionLookup = buildPermissionLookup(schemaModel.tables, config.inheritedRoles);

  // 4b. Configure numeric type stringification before schema generation
  configureStringifyNumericTypes(config.server.stringifyNumericTypes);

  // 4c. Configure webhook security defaults
  configureWebhookDefaults({
    allowPrivateUrls: config.webhook.allowPrivateUrls,
    maxResponseBytes: config.webhook.maxResponseBytes,
  });

  // 5. Generate GraphQL schema (with action fields and tracked functions if configured)
  const graphqlSchema = generateSchema(schemaModel, {
    actions: config.actions,
    actionsGraphql: config.actionsGraphql,
    trackedFunctions: config.trackedFunctions,
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
    bodyLimit: config.server.bodyLimit,
    logger: {
      level: process.env['LOG_LEVEL'] ?? config.server.logLevel,
      transport,
    },
    rewriteUrl(req) {
      let url = req.url ?? '/';
      // Normalize consecutive slashes
      url = url.replace(/\/\/+/g, '/');
      // Hasura-compatible /v1/graphql -> /graphql
      if (url.startsWith('/v1/graphql')) {
        url = '/graphql' + url.slice('/v1/graphql'.length);
      }
      return url;
    },
  });

  const slowQueryThresholdMs = config.slowQueryThresholdMs;

  // ── Debug request/response logging ─────────────────────────────────────
  server.addHook('preHandler', (request, _reply, done) => {
    const logData: Record<string, unknown> = {
      method: request.method,
      url: request.url,
      headers: {
        ...request.headers,
        authorization: request.headers.authorization
          ? request.headers.authorization.slice(0, 20) + '…'
          : undefined,
      },
    };
    if (request.body !== undefined && request.body !== null) {
      logData.body = request.body;
    }
    server.log.debug(logData, 'incoming request');
    done();
  });

  server.addHook('onSend', (request, reply, payload, done) => {
    let body: unknown = payload;
    if (typeof payload === 'string') {
      try { body = JSON.parse(payload); } catch { /* keep as string */ }
    }
    server.log.debug(
      { method: request.method, url: request.url, statusCode: reply.statusCode, body },
      'outgoing response',
    );
    done(null, payload);
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

  // 7c. Mutable ref for inherited roles (updated on hot-reload)
  const inheritedRolesRef: { current: Record<string, string[]> } = { current: config.inheritedRoles };

  // 7d. Create query cache for compiled SQL templates
  const queryCache = createQueryCache(config.queryCache.maxSize);

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
    queryDepth: config.graphql.queryDepth,
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
        queryWithSession: async (
          sql: string,
          params: unknown[],
          session: typeof auth,
          intent: 'read' | 'write',
        ) => {
          const start = performance.now();
          const result = await connectionManager.queryWithSession(sql, params, session, intent);
          const durationMs = performance.now() - start;
          if (slowQueryThresholdMs > 0 && durationMs > slowQueryThresholdMs) {
            server.log.warn(
              { durationMs: Math.round(durationMs * 100) / 100, sql: sql.slice(0, 200), paramCount: params.length },
              'Slow query detected',
            );
          }
          return result;
        },
        permissionLookup: resolverPermissionLookup,
        inheritedRoles: inheritedRolesRef.current,
        tables: schemaModel.tables,
        functions: schemaModel.functions,
        queryCache,
        subscriptionManager: subscriptionRef.manager,
        jobQueue: asyncActionRef.jobQueue,
        pool: asyncActionRef.pool,
        clientHeaders: request.headers as Record<string, string>,
        graphqlMaxLimit: config.graphql.maxLimit,
      };
    },
    subscription: {
      keepAlive: config.subscriptions.keepAliveMs,
      async onConnect(data) {
        // Authenticate the WebSocket connection using connectionParams
        const connectionParams = (data?.payload as Record<string, unknown>) ?? {};
        const session = await authenticateWsConnection(connectionParams, config.auth);
        if (!session) {
          // Returning false / throwing rejects the connection
          throw new Error('WebSocket authentication failed');
        }
        // Store both session and auth on the context.
        // The subscription context function runs BEFORE onConnect in Mercurius,
        // so it sets auth to anonymous. By returning { auth: session } here,
        // onConnect's result overwrites the anonymous auth when merged into this.context.
        return { session, auth: session };
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
          queryWithSession: async (
            sql: string,
            params: unknown[],
            sess: typeof auth,
            intent: 'read' | 'write',
          ) => {
            const start = performance.now();
            const result = await connectionManager.queryWithSession(sql, params, sess, intent);
            const durationMs = performance.now() - start;
            if (slowQueryThresholdMs > 0 && durationMs > slowQueryThresholdMs) {
              server.log.warn(
                { durationMs: Math.round(durationMs * 100) / 100, sql: sql.slice(0, 200), paramCount: params.length },
                'Slow query detected',
              );
            }
            return result;
          },
          permissionLookup: resolverPermissionLookup,
          inheritedRoles: inheritedRolesRef.current,
          tables: schemaModel.tables,
          functions: schemaModel.functions,
          queryCache,
          subscriptionManager: subscriptionRef.manager,
          jobQueue: asyncActionRef.jobQueue,
          pool: asyncActionRef.pool,
          graphqlMaxLimit: config.graphql.maxLimit,
        };
      },
    },
  });

  // 8b. Introspection control: block introspection for disabled roles
  if (config.introspection.disabledForRoles.length > 0) {
    const disabledRoles = new Set(config.introspection.disabledForRoles);
    server.graphql.addHook('preExecution', async (_schema, document, context) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const auth = (context as any)?.auth;
      const role: string | undefined = auth?.role;
      if (role && disabledRoles.has(role)) {
        // Check if any operation uses introspection fields (__schema or __type)
        for (const definition of document.definitions) {
          if (definition.kind === 'OperationDefinition' && definition.selectionSet) {
            for (const selection of definition.selectionSet.selections) {
              if (
                selection.kind === 'Field' &&
                (selection.name.value === '__schema' || selection.name.value === '__type')
              ) {
                throw new mercurius.ErrorWithProps(
                  'GraphQL introspection is not allowed for the current role',
                  { code: 'INTROSPECTION_DISABLED' },
                  400,
                );
              }
            }
          }
        }
      }
    });
  }

  // 9. Register REST routes
  const routerDeps: RESTRouterDeps = {
    getPool: (intent) => connectionManager.getPool(intent),
    getPermission: createPermissionGetter(permissionLookup),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRESTRoutes(server as any, schemaModel.tables, config.rest, routerDeps);

  // 9b. Register Hasura-style REST endpoints (query collections)
  if (config.hasuraRestEndpoints.length > 0) {
    const hasuraRestDeps: HasuraRestDeps = {
      buildContext: (request) => {
        const auth = request.session ?? {
          role: 'anonymous',
          allowedRoles: [] as string[],
          isAdmin: false,
          claims: {},
        };
        return {
          auth,
          queryWithSession: async (
            sql: string,
            params: unknown[],
            session: typeof auth,
            intent: 'read' | 'write',
          ) => {
            const start = performance.now();
            const result = await connectionManager.queryWithSession(sql, params, session, intent);
            const durationMs = performance.now() - start;
            if (slowQueryThresholdMs > 0 && durationMs > slowQueryThresholdMs) {
              server.log.warn(
                { durationMs: Math.round(durationMs * 100) / 100, sql: sql.slice(0, 200), paramCount: params.length },
                'Slow query detected',
              );
            }
            return result;
          },
          permissionLookup: resolverPermissionLookup,
          inheritedRoles: inheritedRolesRef.current,
          tables: schemaModel.tables,
          functions: schemaModel.functions,
          queryCache,
          subscriptionManager: subscriptionRef.manager,
          jobQueue: asyncActionRef.jobQueue,
          pool: asyncActionRef.pool,
          clientHeaders: request.headers as Record<string, string>,
          graphqlMaxLimit: config.graphql.maxLimit,
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerHasuraRestEndpoints(server as any, config.queryCollections, config.hasuraRestEndpoints, hasuraRestDeps);
  }

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

  // Cache for role-filtered SDL (cleared on hot-reload)
  const sdlCache = new Map<string, string>();

  // ── API documentation endpoints (role-filtered) ──────────────────────
  if (config.apiDocs.generate) {
    const allTables = schemaModel.tables;
    const fullSdl = generateGraphQLSDL(graphqlSchema);

    const getDocFilterContext = (request: import('fastify').FastifyRequest) => {
      const session = request.session;
      const role = session?.role ?? config.auth.unauthorizedRole ?? 'anonymous';
      const isAdmin = session?.isAdmin ?? false;
      return { role, isAdmin };
    };

    // OpenAPI spec endpoint
    server.get('/openapi.json', async (request, reply) => {
      const { role, isAdmin } = getDocFilterContext(request);
      const { tables, operationMap } = filterTablesForRole(allTables, role, permissionLookup, isAdmin);
      const spec = generateOpenAPISpec(tables, config.rest, operationMap);
      void reply.code(200).header('content-type', 'application/json').send(spec);
    });

    // LLM-friendly doc endpoint
    if (config.apiDocs.llmFormat) {
      server.get('/llm-api.json', async (request, reply) => {
        const { role, isAdmin } = getDocFilterContext(request);
        const { tables, operationMap } = filterTablesForRole(allTables, role, permissionLookup, isAdmin);
        const doc = generateLLMDoc(tables, config.rest, operationMap);
        void reply.code(200).header('content-type', 'application/json').send(doc);
      });
    }

    // GraphQL SDL endpoint (role-filtered with caching)
    server.get('/sdl', async (request, reply) => {
      const { role, isAdmin } = getDocFilterContext(request);
      if (isAdmin) {
        void reply.code(200).header('content-type', 'text/plain; charset=utf-8').send(fullSdl);
        return;
      }

      let cachedSdl = sdlCache.get(role);
      if (!cachedSdl) {
        const { tables } = filterTablesForRole(allTables, role, permissionLookup, isAdmin);
        if (tables.length === 0) {
          cachedSdl = '# No accessible types for this role\n';
        } else {
          // Include all tables referenced by relationships (transitively) so
          // the schema generator can resolve relationship type lookups.
          const includedNames = new Set(tables.map(t => t.name));
          const expandedTables = [...tables];
          const queue = [...tables];
          while (queue.length > 0) {
            const t = queue.pop()!;
            for (const rel of t.relationships) {
              if (!includedNames.has(rel.remoteTable.name)) {
                const remoteTable = allTables.find(at => at.name === rel.remoteTable.name && at.schema === rel.remoteTable.schema);
                if (remoteTable) {
                  expandedTables.push(remoteTable);
                  includedNames.add(remoteTable.name);
                  queue.push(remoteTable);
                }
              }
            }
          }
          try {
            const filteredModel: SchemaModel = { ...schemaModel, tables: expandedTables };
            const rootFieldTables = new Set(tables.map(t => t.name));
            // Reset module-level type caches to avoid conflicts between
            // the full schema's enum types and the filtered schema's new instances.
            resetComparisonTypeCache();
            const filteredSchema = generateSchema(filteredModel, {
              actions: config.actions,
              actionsGraphql: config.actionsGraphql,
              trackedFunctions: config.trackedFunctions,
              rootFieldTables,
            });
            cachedSdl = generateGraphQLSDL(filteredSchema);
          } catch (err) {
            server.log.warn({ err }, 'Failed to generate role-filtered SDL, using full SDL');
            cachedSdl = fullSdl;
          }
        }
        sdlCache.set(role, cachedSdl);
      }

      void reply.code(200).header('content-type', 'text/plain; charset=utf-8').send(cachedSdl);
    });
  }

  // ── Phase 2: job queue, events, crons, subscriptions ────────────────

  // Resolve the primary database connection string for job queue
  const primaryUrlEnv = config.databases.primary.urlEnv;
  const primaryConnectionString = process.env[primaryUrlEnv] ?? '';

  // Session connection string for LISTEN/NOTIFY (separate from pool for PgBouncer compat)
  const sessionConnectionString = connectionManager.getSessionConnectionString();

  let jobQueue: JobQueue | undefined;
  let eventManager: EventManager | undefined;
  let changeListener: ChangeListener | undefined;
  let subscriptionMgr: SubscriptionManager | undefined;
  let redisFanout: RedisFanoutBridge | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = server.log as any;


  if (primaryConnectionString) {
    try {
      // Start job queue (shared by events, crons, and async actions)
      // Determine provider from config (default: pg-boss)
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
        // Initialize cron triggers
        await initCronTriggers(jobQueue, config.cronTriggers, log);

        // Initialize event triggers
        eventManager = await initEventTriggers(
          primaryPool,
          jobQueue,
          schemaModel.tables,
          sessionConnectionString,
          log,
          { batchSize: config.eventDelivery.batchSize, schemaName },
        );

        // Register event log cleanup
        await registerEventCleanup(jobQueue, primaryPool, config.eventLogRetentionDays, log, {
          schedule: config.eventCleanup.schedule,
          schemaName,
        });
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

      // Reconcile subscription triggers (diff-based)
      const desiredSubTriggers = buildDesiredSubscriptionTriggers(schemaModel.tables, schemaName);
      const subReconcile = await reconcileTriggers(
        primaryPool,
        desiredSubTriggers,
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

      // Create change listener for subscriptions
      changeListener = createChangeListener(sessionConnectionString, schemaName);
      subscriptionMgr = createSubscriptionManager(connectionManager, log, {
        queryRouting: config.databases.subscriptionQueryRouting ?? 'primary',
        debounceMs: config.subscriptions.debounceMs,
      });

      // Make the subscription manager available to resolver contexts
      subscriptionRef.manager = subscriptionMgr;

      // Set up the notification pipeline
      if (config.redis) {
        // Multi-instance mode: PG NOTIFY -> local handler + Redis publish
        //                      Redis SUB -> remote handler
        try {
          redisFanout = await createRedisFanoutBridge(config.redis, log);

          // PG notifications: handle locally AND publish to Redis
          changeListener.onTableChange((notification) => {
            subscriptionMgr!.handleChange(notification).catch((err) => {
              server.log.error({ err }, 'Error handling subscription change');
            });
            redisFanout!.publish(notification).catch((err) => {
              server.log.error({ err }, 'Error publishing to Redis fanout');
            });
          });

          // Remote notifications from Redis: handle locally
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

          // Fall back to single-instance wiring
          changeListener.onTableChange((notification) => {
            subscriptionMgr!.handleChange(notification).catch((err2) => {
              server.log.error({ err: err2 }, 'Error handling subscription change');
            });
          });
        }
      } else {
        // Single-instance mode: PG NOTIFY -> local handler only (existing behavior)
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
      debounceMs: CONFIG_DEFAULTS.configWatcherDebounceMs,
    });

    configWatcher.on('change', async (files: string[]) => {
      server.log.info({ files }, 'Config changed, reloading schema...');
      try {
        const newConfig = await loadConfig(options.metadataPath!, options.configPath);
        const newSchemas = new Set<string>(['public']);
        if (newConfig.trackedFunctions) {
          for (const fn of newConfig.trackedFunctions) {
            if (fn.schema) newSchemas.add(fn.schema);
          }
        }
        const newIntrospection = await introspectDatabase(primaryPool, [...newSchemas]);
        const newMerge = mergeSchemaModel(newIntrospection, newConfig);
        await resolveTableEnums(newMerge.model, primaryPool);
        const newPermLookup = buildPermissionLookup(newMerge.model.tables, newConfig.inheritedRoles);
        configureStringifyNumericTypes(newConfig.server.stringifyNumericTypes);
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

        // Update permission lookup and inherited roles
        const newResolverPL = createResolverPermissionLookup(newPermLookup);
        Object.assign(resolverPermissionLookup, newResolverPL);
        inheritedRolesRef.current = newConfig.inheritedRoles;

        // Clear caches on schema change
        queryCache.clear();
        sdlCache.clear();

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
      await redisFanout?.stop();
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
