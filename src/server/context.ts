/**
 * Resolver context factory and permission adapters.
 *
 * Centralises the context-building logic that was previously duplicated
 * across the GraphQL context, subscription context, and Hasura REST
 * context in server.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { TableInfo, CompiledPermission, SessionVariables, FunctionInfo } from '../types.js';
import type { ConnectionManager } from '../connections/manager.js';
import type { PermissionLookup } from '../permissions/lookup.js';
import type { QueryCache } from '../sql/cache.js';
import type { SubscriptionManager } from '../subscriptions/manager.js';
import type { JobQueue } from '../shared/job-queue/types.js';
import type { ResolverPermissionLookup, ResolverContext } from '../schema/resolvers.js';
import type { Pool } from 'pg';

// ─── Permission adapters ─────────────────────────────────────────────────────

/**
 * Create a permission getter function compatible with RESTRouterDeps.
 */
export function createPermissionGetter(
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
export function createResolverPermissionLookup(
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

// ─── Mutable refs ────────────────────────────────────────────────────────────

/** Mutable reference for the subscription manager (populated after Mercurius registration). */
export interface SubscriptionRef {
  manager: SubscriptionManager | undefined;
}

/** Mutable reference for async action services (populated after job queue init). */
export interface AsyncActionRef {
  jobQueue: JobQueue | undefined;
  pool: Pool | undefined;
}

/** Mutable reference for inherited roles (updated on hot-reload). */
export interface InheritedRolesRef {
  current: Record<string, string[]>;
}

// ─── Context factory ─────────────────────────────────────────────────────────

export interface ContextFactoryDeps {
  connectionManager: ConnectionManager;
  resolverPermissionLookup: ResolverPermissionLookup;
  inheritedRolesRef: InheritedRolesRef;
  tables: TableInfo[];
  functions: FunctionInfo[];
  queryCache: QueryCache;
  subscriptionRef: SubscriptionRef;
  asyncActionRef: AsyncActionRef;
  slowQueryThresholdMs: number;
  server: FastifyInstance;
  graphqlMaxLimit?: number;
}

/**
 * Build a ResolverContext for a given auth session.
 *
 * This factory is used by the Mercurius context function, the subscription
 * context, and Hasura REST endpoints — eliminating the previous 3x duplication.
 */
export function buildResolverContext(
  deps: ContextFactoryDeps,
  auth: SessionVariables,
  clientHeaders?: Record<string, string>,
): ResolverContext {
  const {
    connectionManager,
    resolverPermissionLookup,
    inheritedRolesRef,
    tables,
    functions,
    queryCache,
    subscriptionRef,
    asyncActionRef,
    slowQueryThresholdMs,
    server,
    graphqlMaxLimit,
  } = deps;

  return {
    auth,
    queryWithSession: async (
      sql: string,
      params: unknown[],
      session: SessionVariables,
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
    tables,
    functions,
    queryCache,
    subscriptionManager: subscriptionRef.manager,
    jobQueue: asyncActionRef.jobQueue,
    pool: asyncActionRef.pool,
    ...(clientHeaders !== undefined ? { clientHeaders } : {}),
    graphqlMaxLimit,
  };
}

// ─── Default anonymous session ───────────────────────────────────────────────

export const ANONYMOUS_SESSION: SessionVariables = {
  role: 'anonymous',
  allowedRoles: [],
  isAdmin: false,
  claims: {},
};
