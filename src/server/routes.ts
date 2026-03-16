/**
 * Route registration: GraphQL debug hooks, REST, Hasura REST, health,
 * and API documentation endpoints.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GraphQLSchema } from 'graphql';
import type { HakkyraConfig, TableInfo, SchemaModel } from '../types.js';
import type { ConnectionManager } from '../connections/manager.js';
import type { PermissionLookup } from '../permissions/lookup.js';
import { registerRESTRoutes } from '../rest/router.js';
import type { RESTRouterDeps } from '../rest/router.js';
import { registerHasuraRestEndpoints } from '../rest/hasura-endpoints.js';
import type { HasuraRestDeps } from '../rest/hasura-endpoints.js';
import { generateOpenAPISpec } from '../docs/openapi.js';
import { generateLLMDoc } from '../docs/llm-format.js';
import { generateGraphQLSDL } from '../docs/graphql-sdl.js';
import { filterTablesForRole } from '../docs/role-filter.js';
import { generateSchema } from '../schema/generator.js';
import { resetComparisonTypeCache } from '../schema/filters.js';
import { createPermissionGetter, buildResolverContext, ANONYMOUS_SESSION } from './context.js';
import type { ContextFactoryDeps } from './context.js';

// ─── Debug request/response logging hooks ────────────────────────────────────

export function registerDebugHooks(server: FastifyInstance): void {
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

    // Log GraphQL errors at error level so they're visible even at warn log level
    if (body && typeof body === 'object' && 'errors' in body) {
      const { errors } = body as { errors?: unknown[] };
      if (Array.isArray(errors) && errors.length > 0) {
        server.log.error(
          { method: request.method, url: request.url, requestBody: request.body, errors },
          'GraphQL request returned errors',
        );
      }
    }

    server.log.debug(
      { method: request.method, url: request.url, statusCode: reply.statusCode, body },
      'outgoing response',
    );
    done(null, payload);
  });
}

// ─── REST routes ─────────────────────────────────────────────────────────────

export function registerRESTWithManager(
  server: FastifyInstance,
  tables: TableInfo[],
  config: HakkyraConfig,
  permissionLookup: PermissionLookup,
  connectionManager: ConnectionManager,
): void {
  const routerDeps: RESTRouterDeps = {
    getPool: (intent) => connectionManager.getPool(intent),
    getPermission: createPermissionGetter(permissionLookup),
  };
  registerRESTRoutes(server, tables, config.rest, routerDeps);
}

// ─── Hasura REST endpoints ───────────────────────────────────────────────────

export function registerHasuraREST(
  server: FastifyInstance,
  config: HakkyraConfig,
  contextDeps: ContextFactoryDeps,
): void {
  if (config.hasuraRestEndpoints.length === 0) return;

  const hasuraRestDeps: HasuraRestDeps = {
    buildContext: (request) => {
      const auth = request.session ?? ANONYMOUS_SESSION;
      return buildResolverContext(contextDeps, auth, request.headers as Record<string, string>);
    },
  };
  registerHasuraRestEndpoints(server, config.queryCollections, config.hasuraRestEndpoints, hasuraRestDeps);
}

// ─── Health / readiness endpoints ────────────────────────────────────────────

export function registerHealthEndpoints(
  server: FastifyInstance,
  connectionManager: ConnectionManager,
): void {
  server.get('/healthz', async (_request, reply) => {
    void reply.code(200).send({ status: 'ok' });
  });

  server.get('/readyz', async (_request, reply) => {
    const healthy = await connectionManager.healthCheck();
    if (healthy) {
      void reply.code(200).send({ status: 'ok' });
    } else {
      void reply.code(503).send({ status: 'unavailable', message: 'Database connection failed' });
    }
  });
}

// ─── API documentation endpoints (role-filtered) ─────────────────────────────

export interface DocEndpointsDeps {
  server: FastifyInstance;
  config: HakkyraConfig;
  schemaModel: SchemaModel;
  graphqlSchema: GraphQLSchema;
  permissionLookup: PermissionLookup;
}

/**
 * Register /openapi.json, /llm-api.json, and /sdl endpoints with
 * role-based filtering. Returns the SDL cache for hot-reload invalidation.
 */
export function registerDocEndpoints(deps: DocEndpointsDeps): Map<string, string> {
  const { server, config, schemaModel, graphqlSchema, permissionLookup } = deps;
  const sdlCache = new Map<string, string>();

  if (!config.apiDocs.generate) return sdlCache;

  const allTables = schemaModel.tables;
  const fullSdl = generateGraphQLSDL(graphqlSchema);

  const getDocFilterContext = (request: FastifyRequest) => {
    const session = request.session;
    const isAdmin = session?.isAdmin ?? false;
    // When admin key is used with x-hasura-role header, use that role for filtering
    // instead of showing the full admin schema
    const roleHeader = (request.headers['x-hasura-role'] as string | undefined)?.toLowerCase();
    const hasRoleOverride = isAdmin && roleHeader && roleHeader !== 'admin';
    const role = hasRoleOverride ? roleHeader : (session?.role ?? config.auth.unauthorizedRole ?? 'anonymous');
    return { role, isAdmin: isAdmin && !hasRoleOverride };
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
        // Include all tables referenced by relationships (transitively)
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

  return sdlCache;
}
