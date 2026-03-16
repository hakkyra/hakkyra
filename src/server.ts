/**
 * Main server factory — thin orchestrator.
 *
 * Creates and configures a Fastify instance by delegating to phase modules:
 * - server/context.ts  — resolver context factory and permission adapters
 * - server/schema.ts   — CJS/ESM schema reconciliation, introspection control
 * - server/jobs.ts     — job queue, events, crons, async actions, subscriptions
 * - server/routes.ts   — route registration (REST, health, docs, debug hooks)
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';
import type { HakkyraConfig, TableInfo, SchemaModel } from './types.js';
import { createConnectionManager } from './connections/manager.js';
import type { ConnectionManager } from './connections/manager.js';
import { introspectDatabase } from './introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from './introspection/merger.js';
import { buildPermissionLookup } from './permissions/lookup.js';
import type { PermissionLookup } from './permissions/lookup.js';
import { generateSchema } from './schema/generator.js';
import { createAuthHook } from './auth/middleware.js';
import { createQueryCache } from './sql/cache.js';
import { createConfigWatcher } from './config/watcher.js';
import type { ConfigWatcher } from './config/watcher.js';
import { loadConfig } from './config/loader.js';
import { authenticateWsConnection } from './auth/ws-auth.js';
import { CONFIG_DEFAULTS } from './config/schemas-internal.js';
import { configureStringifyNumericTypes } from './introspection/type-map.js';
import { configureWebhookDefaults } from './shared/webhook.js';

import {
  createResolverPermissionLookup,
  buildResolverContext,
  ANONYMOUS_SESSION,
} from './server/context.js';
import type {
  SubscriptionRef,
  AsyncActionRef,
  InheritedRolesRef,
  ContextFactoryDeps,
} from './server/context.js';
import { buildCjsSchema, registerIntrospectionControl } from './server/schema.js';
import { initPhase2 } from './server/jobs.js';
import {
  registerDebugHooks,
  registerRESTWithManager,
  registerHasuraREST,
  registerHealthEndpoints,
  registerDocEndpoints,
} from './server/routes.js';

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
  registerDebugHooks(server);

  // ── GraphQL batching limit ───────────────────────────────────────────
  const maxBatchSize = config.graphql.maxBatchSize;
  if (maxBatchSize > 0) {
    server.addHook('preHandler', (request, reply, done) => {
      // Only apply to GraphQL endpoint
      if (request.url === '/graphql' || request.url === '/v1/graphql') {
        if (Array.isArray(request.body)) {
          if (request.body.length > maxBatchSize) {
            void reply.code(400).send({
              errors: [{
                message: `Batched GraphQL request exceeds maximum batch size of ${maxBatchSize}`,
                extensions: { code: 'BATCH_SIZE_EXCEEDED', maxBatchSize },
              }],
            });
            return;
          }
        }
      }
      done();
    });
  }

  // 7. Register auth middleware (must be BEFORE Mercurius so preHandler runs)
  await server.register(createAuthHook(config.auth));

  // 8. Build CJS schema for Mercurius (ESM/CJS dual-package workaround)
  const cjsSchema = buildCjsSchema(graphqlSchema);

  // 8b. Build the resolver permission lookup adapter
  const resolverPermissionLookup = createResolverPermissionLookup(permissionLookup);

  // 8c. Mutable ref for inherited roles (updated on hot-reload)
  const inheritedRolesRef: InheritedRolesRef = { current: config.inheritedRoles };

  // 8d. Create query cache for compiled SQL templates
  const queryCache = createQueryCache(config.queryCache.maxSize);

  // 8e. Mutable references for services initialized after Mercurius registration.
  // The context closure captures these objects by reference.
  const subscriptionRef: SubscriptionRef = { manager: undefined };
  const asyncActionRef: AsyncActionRef = { jobQueue: undefined, pool: undefined };

  // Shared context factory deps (used by GraphQL, subscriptions, and Hasura REST)
  const contextDeps: ContextFactoryDeps = {
    connectionManager,
    resolverPermissionLookup,
    inheritedRolesRef,
    tables: schemaModel.tables,
    functions: schemaModel.functions,
    queryCache,
    subscriptionRef,
    asyncActionRef,
    slowQueryThresholdMs,
    server,
    graphqlMaxLimit: config.graphql.maxLimit,
  };

  await server.register(mercurius, {
    schema: cjsSchema,
    graphiql: process.env['NODE_ENV'] !== 'production',
    path: '/graphql',
    queryDepth: config.graphql.queryDepth,
    context: (request) => {
      const auth = request.session ?? ANONYMOUS_SESSION;
      return buildResolverContext(contextDeps, auth, request.headers as Record<string, string>);
    },
    subscription: {
      keepAlive: config.subscriptions.keepAliveMs,
      async onConnect(data) {
        const connectionParams = (data?.payload as Record<string, unknown>) ?? {};
        const session = await authenticateWsConnection(connectionParams, config.auth);
        if (!session) {
          throw new Error('WebSocket authentication failed');
        }
        return { session, auth: session };
      },
      context(_connection, context) {
        // Mercurius stores onConnect results on _connectionInit or directly on context
        const ctx = context as unknown as Record<string, unknown>;
        const connectResult = (ctx._connectionInit ?? ctx) as Record<string, unknown>;
        const session = (connectResult.session ?? ctx.session) as import('./types.js').SessionVariables | undefined;
        const auth = session ?? ANONYMOUS_SESSION;
        return buildResolverContext(contextDeps, auth);
      },
    },
  });

  // 8f. Introspection control: block introspection for disabled roles
  registerIntrospectionControl(server, config.introspection.disabledForRoles);

  // 9. Register REST routes
  registerRESTWithManager(server, schemaModel.tables, config, permissionLookup, connectionManager);

  // 9b. Register Hasura-style REST endpoints (query collections)
  registerHasuraREST(server, config, contextDeps);

  // ── Health / readiness endpoints ────────────────────────────────────────
  registerHealthEndpoints(server, connectionManager);

  // ── API documentation endpoints (role-filtered) ─────────────────────────
  const sdlCache = registerDocEndpoints({
    server,
    config,
    schemaModel,
    graphqlSchema,
    permissionLookup,
  });

  // ── Phase 2: job queue, events, crons, subscriptions ────────────────────
  const phase2 = await initPhase2({
    server,
    config,
    connectionManager,
    primaryPool,
    tables: schemaModel.tables,
    schemaName,
    subscriptionRef,
    asyncActionRef,
  });

  // ── Dev mode config watcher ────────────────────────────────────────────
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
        const newCjsSchema = buildCjsSchema(newSchema);

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
      await phase2.redisFanout?.stop();
      await phase2.changeListener?.stop();
      await phase2.eventManager?.stop();
      await phase2.jobQueue?.stop();
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

  return server;
}

// ─── Fastify augmentation ────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    connectionManager: ConnectionManager;
    permissionLookup: PermissionLookup;
    trackedTables: TableInfo[];
  }
}
