/**
 * REST API route generator.
 *
 * Auto-generates CRUD routes for each tracked table, translating
 * REST requests into the same internal query format used by GraphQL resolvers.
 * Routes use PostgREST-style filtering via query parameters.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type {
  TableInfo,
  RESTConfig,
  RESTEndpointOverride,
  BoolExp,
  ColumnOperators,
  SessionVariables,
  CompiledPermission,
} from '../types.js';
import { parseRESTFilters } from './filters.js';
import type { ParsedRESTQuery, OrderByClause } from './filters.js';
import { MutationBodySchema, PaginationSchema } from './schemas.js';
import { ParamCollector, quoteIdentifier, quoteTableRef } from '../sql/utils.js';
import { compileWhere } from '../sql/where.js';
import { compileSelectAggregate } from '../sql/select.js';
import type { AggregateSelection } from '../sql/select.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RESTRouterDeps {
  getPool: (intent: 'read' | 'write') => Pool;
  getPermission: (table: TableInfo, role: string) => CompiledPermission | undefined;
}

interface RouteTable {
  table: TableInfo;
  urlName: string;
}

// ─── SQL builders ────────────────────────────────────────────────────────────

function buildSelectSQL(
  table: TableInfo,
  parsed: ParsedRESTQuery,
  session: SessionVariables,
  permission: CompiledPermission | undefined,
  config: RESTConfig,
): { sql: string; params: unknown[] } {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(table.schema, table.name);
  const alias = quoteIdentifier('t');

  // Determine allowed columns
  const selectPerm = permission?.select;
  const allowedColumns = selectPerm?.columns === '*'
    ? table.columns.map((c) => c.name)
    : (selectPerm?.columns ?? table.columns.map((c) => c.name));

  // Determine which columns to select
  let selectedColumns: string[];
  if (parsed.select && parsed.select.length > 0) {
    selectedColumns = parsed.select.filter((c) => allowedColumns.includes(c));
    if (selectedColumns.length === 0) {
      selectedColumns = allowedColumns;
    }
  } else {
    selectedColumns = allowedColumns;
  }

  const columnList = selectedColumns.map((c) => `${alias}.${quoteIdentifier(c)}`).join(', ');

  // DISTINCT ON
  let distinctOnClause = '';
  if (parsed.distinctOn && parsed.distinctOn.length > 0) {
    // Filter distinct_on columns to allowed columns
    const validDistinctCols = parsed.distinctOn.filter((c) => allowedColumns.includes(c));
    if (validDistinctCols.length > 0) {
      const distinctCols = validDistinctCols.map((c) => `${alias}.${quoteIdentifier(c)}`).join(', ');
      distinctOnClause = `DISTINCT ON (${distinctCols}) `;

      // Ensure ORDER BY starts with distinct columns (PostgreSQL requirement)
      const existingOrderCols = new Set(parsed.orderBy.map((o) => o.column));
      const prependOrder: OrderByClause[] = [];
      for (const col of validDistinctCols) {
        if (!existingOrderCols.has(col)) {
          prependOrder.push({ column: col, direction: 'asc' });
        }
      }
      if (prependOrder.length > 0) {
        // Reorder: distinct columns first, then existing order
        const distinctSet = new Set(validDistinctCols);
        const existingInDistinct = parsed.orderBy.filter((o) => distinctSet.has(o.column));
        const existingNotInDistinct = parsed.orderBy.filter((o) => !distinctSet.has(o.column));
        parsed.orderBy = [...existingInDistinct, ...prependOrder, ...existingNotInDistinct];
      } else {
        // Ensure distinct columns come first in ORDER BY
        const distinctSet = new Set(validDistinctCols);
        const inDistinct = parsed.orderBy.filter((o) => distinctSet.has(o.column));
        const notInDistinct = parsed.orderBy.filter((o) => !distinctSet.has(o.column));
        parsed.orderBy = [...inDistinct, ...notInDistinct];
      }
      // If no ORDER BY was specified at all, add the distinct columns
      if (parsed.orderBy.length === 0) {
        parsed.orderBy = validDistinctCols.map((c) => ({ column: c, direction: 'asc' as const }));
      }
    }
  }

  // Build WHERE clause combining user filters and permission filters
  const whereParts: string[] = [];

  // User-provided filters
  const userWhere = compileWhere(parsed.where, params, 't', session);
  if (userWhere) {
    whereParts.push(userWhere);
  }

  // Permission filter
  if (selectPerm?.filter) {
    const permWhere = selectPerm.filter.toSQL(session, params.getOffset(), 't');
    if (permWhere.sql) {
      for (const p of permWhere.params) {
        params.add(p);
      }
      whereParts.push(permWhere.sql);
    }
  }

  const whereClause = whereParts.length > 0
    ? ` WHERE ${whereParts.join(' AND ')}`
    : '';

  // ORDER BY
  let orderClause = '';
  if (parsed.orderBy.length > 0) {
    const orderParts = parsed.orderBy
      .filter((o) => allowedColumns.includes(o.column))
      .map((o) => {
        let part = `${alias}.${quoteIdentifier(o.column)} ${o.direction.toUpperCase()}`;
        if (o.nulls) {
          part += ` NULLS ${o.nulls.toUpperCase()}`;
        }
        return part;
      });
    if (orderParts.length > 0) {
      orderClause = ` ORDER BY ${orderParts.join(', ')}`;
    }
  }

  // LIMIT / OFFSET
  const permLimit = selectPerm?.limit;
  let effectiveLimit = parsed.limit ?? config.pagination.defaultLimit;
  if (permLimit !== undefined && effectiveLimit > permLimit) {
    effectiveLimit = permLimit;
  }
  if (effectiveLimit > config.pagination.maxLimit) {
    effectiveLimit = config.pagination.maxLimit;
  }

  const limitClause = ` LIMIT ${params.add(effectiveLimit)}`;
  const offsetClause = parsed.offset !== undefined && parsed.offset > 0
    ? ` OFFSET ${params.add(parsed.offset)}`
    : '';

  const sql = `SELECT ${distinctOnClause}${columnList} FROM ${tableRef} ${alias}${whereClause}${orderClause}${limitClause}${offsetClause}`;

  return { sql, params: params.getParams() };
}

function buildSelectByPKSQL(
  table: TableInfo,
  pkValues: Record<string, unknown>,
  session: SessionVariables,
  permission: CompiledPermission | undefined,
): { sql: string; params: unknown[] } {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(table.schema, table.name);
  const alias = quoteIdentifier('t');

  const selectPerm = permission?.select;
  const allowedColumns = selectPerm?.columns === '*'
    ? table.columns.map((c) => c.name)
    : (selectPerm?.columns ?? table.columns.map((c) => c.name));

  const columnList = allowedColumns.map((c) => `${alias}.${quoteIdentifier(c)}`).join(', ');

  // PK conditions
  const pkParts: string[] = [];
  for (const pkCol of table.primaryKey) {
    const value = pkValues[pkCol];
    pkParts.push(`${alias}.${quoteIdentifier(pkCol)} = ${params.add(value)}`);
  }

  // Permission filter
  const whereParts = [...pkParts];
  if (selectPerm?.filter) {
    const permWhere = selectPerm.filter.toSQL(session, params.getOffset(), 't');
    if (permWhere.sql) {
      for (const p of permWhere.params) {
        params.add(p);
      }
      whereParts.push(permWhere.sql);
    }
  }

  const whereClause = ` WHERE ${whereParts.join(' AND ')}`;
  const sql = `SELECT ${columnList} FROM ${tableRef} ${alias}${whereClause} LIMIT 1`;

  return { sql, params: params.getParams() };
}

function buildInsertSQL(
  table: TableInfo,
  body: Record<string, unknown>,
  session: SessionVariables,
  permission: CompiledPermission | undefined,
  onConflict?: { constraint: string; update_columns?: string[]; where?: BoolExp },
): { sql: string; params: unknown[] } {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(table.schema, table.name);

  const insertPerm = permission?.insert;
  const allowedColumns = insertPerm?.columns === '*'
    ? table.columns.map((c) => c.name)
    : (insertPerm?.columns ?? table.columns.map((c) => c.name));

  // Apply presets — presets override user-provided values
  const presets = insertPerm?.presets ?? {};
  const mergedBody: Record<string, unknown> = { ...body };
  for (const [col, value] of Object.entries(presets)) {
    mergedBody[col] = resolvePresetValue(value, session);
  }

  // Filter to allowed columns that are present in the body
  const columns: string[] = [];
  const values: string[] = [];
  for (const col of allowedColumns) {
    if (col in mergedBody) {
      columns.push(col);
      values.push(params.add(mergedBody[col]));
    }
  }

  if (columns.length === 0) {
    // Insert with defaults only
    const returnCols = table.columns.map((c) => quoteIdentifier(c.name)).join(', ');
    return {
      sql: `INSERT INTO ${tableRef} DEFAULT VALUES RETURNING ${returnCols}`,
      params: params.getParams(),
    };
  }

  const columnList = columns.map((c) => quoteIdentifier(c)).join(', ');
  const valueList = values.join(', ');
  const returnCols = allowedColumns.map((c) => quoteIdentifier(c)).join(', ');

  // Build ON CONFLICT clause for upsert
  let onConflictClause = '';
  if (onConflict) {
    const constraintRef = quoteIdentifier(onConflict.constraint);
    const updateCols = onConflict.update_columns ?? [];

    if (updateCols.length > 0) {
      // Filter update columns to allowed columns
      const validUpdateCols = updateCols.filter((c) => allowedColumns.includes(c));
      if (validUpdateCols.length > 0) {
        const updates = validUpdateCols.map(
          (c) => `${quoteIdentifier(c)} = EXCLUDED.${quoteIdentifier(c)}`,
        ).join(', ');
        onConflictClause = ` ON CONFLICT ON CONSTRAINT ${constraintRef} DO UPDATE SET ${updates}`;

        // Optional WHERE clause on the DO UPDATE
        if (onConflict.where) {
          const whereSQL = compileWhere(onConflict.where, params, table.name, session);
          if (whereSQL) {
            onConflictClause += ` WHERE ${whereSQL}`;
          }
        }
      } else {
        onConflictClause = ` ON CONFLICT ON CONSTRAINT ${constraintRef} DO NOTHING`;
      }
    } else {
      onConflictClause = ` ON CONFLICT ON CONSTRAINT ${constraintRef} DO NOTHING`;
    }
  }

  const sql = `INSERT INTO ${tableRef} (${columnList}) VALUES (${valueList})${onConflictClause} RETURNING ${returnCols}`;

  return { sql, params: params.getParams() };
}

function buildUpdateSQL(
  table: TableInfo,
  pkValues: Record<string, unknown>,
  body: Record<string, unknown>,
  session: SessionVariables,
  permission: CompiledPermission | undefined,
): { sql: string; params: unknown[] } {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(table.schema, table.name);
  const alias = quoteIdentifier('t');

  const updatePerm = permission?.update;
  const allowedColumns = updatePerm?.columns === '*'
    ? table.columns.map((c) => c.name)
    : (updatePerm?.columns ?? table.columns.map((c) => c.name));

  // Apply presets
  const presets = updatePerm?.presets ?? {};
  const mergedBody: Record<string, unknown> = { ...body };
  for (const [col, value] of Object.entries(presets)) {
    mergedBody[col] = resolvePresetValue(value, session);
  }

  // Build SET clause with allowed columns only
  const setParts: string[] = [];
  for (const col of allowedColumns) {
    if (col in mergedBody) {
      setParts.push(`${quoteIdentifier(col)} = ${params.add(mergedBody[col])}`);
    }
  }

  if (setParts.length === 0) {
    return { sql: '', params: [] };
  }

  // PK conditions
  const pkParts: string[] = [];
  for (const pkCol of table.primaryKey) {
    pkParts.push(`${alias}.${quoteIdentifier(pkCol)} = ${params.add(pkValues[pkCol])}`);
  }

  // Permission filter
  const whereParts = [...pkParts];
  if (updatePerm?.filter) {
    const permWhere = updatePerm.filter.toSQL(session, params.getOffset(), 't');
    if (permWhere.sql) {
      for (const p of permWhere.params) {
        params.add(p);
      }
      whereParts.push(permWhere.sql);
    }
  }

  const whereClause = ` WHERE ${whereParts.join(' AND ')}`;
  const returnCols = allowedColumns.map((c) => quoteIdentifier(c)).join(', ');

  // Use UPDATE ... FROM pattern for alias support
  const sql = `UPDATE ${tableRef} AS ${alias} SET ${setParts.join(', ')}${whereClause} RETURNING ${returnCols}`;

  return { sql, params: params.getParams() };
}

function buildDeleteSQL(
  table: TableInfo,
  pkValues: Record<string, unknown>,
  session: SessionVariables,
  permission: CompiledPermission | undefined,
): { sql: string; params: unknown[] } {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(table.schema, table.name);
  const alias = quoteIdentifier('t');

  // PK conditions
  const pkParts: string[] = [];
  for (const pkCol of table.primaryKey) {
    pkParts.push(`${alias}.${quoteIdentifier(pkCol)} = ${params.add(pkValues[pkCol])}`);
  }

  // Permission filter
  const whereParts = [...pkParts];
  const deletePerm = permission?.delete;
  if (deletePerm?.filter) {
    const permWhere = deletePerm.filter.toSQL(session, params.getOffset(), 't');
    if (permWhere.sql) {
      for (const p of permWhere.params) {
        params.add(p);
      }
      whereParts.push(permWhere.sql);
    }
  }

  const whereClause = ` WHERE ${whereParts.join(' AND ')}`;
  const sql = `DELETE FROM ${tableRef} AS ${alias}${whereClause} RETURNING *`;

  return { sql, params: params.getParams() };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a preset value that may reference a session variable.
 */
function resolvePresetValue(value: string, session: SessionVariables): unknown {
  const lower = value.toLowerCase();
  if (lower.startsWith('x-hasura-')) {
    if (lower === 'x-hasura-user-id') return session.userId;
    if (lower === 'x-hasura-role') return session.role;
    // Look up in claims
    const claimKey = lower.slice('x-hasura-'.length);
    if (session.claims[claimKey] !== undefined) return session.claims[claimKey];
    for (const [k, v] of Object.entries(session.claims)) {
      if (k.toLowerCase() === claimKey) return v;
    }
    return undefined;
  }
  return value;
}

/**
 * Extract primary key values from the route URL parameter.
 * Supports single PK (`:id`) and composite PKs (`pk1,pk2` in the id param).
 */
function extractPKValues(table: TableInfo, idParam: string): Record<string, unknown> {
  const pkValues: Record<string, unknown> = {};
  const parts = idParam.split(',');

  for (let i = 0; i < table.primaryKey.length; i++) {
    const pkCol = table.primaryKey[i];
    const rawValue = parts[i];
    if (rawValue === undefined) {
      throw new Error(`Missing value for primary key column "${pkCol}"`);
    }
    // Coerce the PK value based on column type
    const column = table.columns.find((c) => c.name === pkCol);
    pkValues[pkCol] = coercePKValue(rawValue, column?.udtName);
  }

  return pkValues;
}

/**
 * Coerce a PK string value to the appropriate type based on the column type.
 */
function coercePKValue(value: string, udtName?: string): unknown {
  if (!udtName) return value;
  if (['int2', 'int4', 'int8', 'serial', 'serial4', 'serial8', 'bigserial', 'oid'].includes(udtName)) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  if (['float4', 'float8', 'numeric'].includes(udtName)) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  if (udtName === 'bool') {
    return value === 'true' || value === '1';
  }
  return value;
}

/**
 * Get the URL path name for a table, using alias if defined.
 */
function getURLName(table: TableInfo): string {
  return table.alias ?? table.name;
}

/**
 * Check if a session has permission for a given operation on a table.
 */
function checkPermission(
  table: TableInfo,
  operation: 'select' | 'insert' | 'update' | 'delete',
  session: SessionVariables,
): boolean {
  if (session.isAdmin) return true;
  const perms = table.permissions[operation];
  return session.role in perms;
}

// ─── Error responses ─────────────────────────────────────────────────────────

function sendBadRequest(reply: FastifyReply, message: string): void {
  void reply.code(400).send({ error: 'bad_request', message });
}

function sendUnauthorized(reply: FastifyReply, message: string): void {
  void reply.code(401).send({ error: 'unauthorized', message });
}

function sendForbidden(reply: FastifyReply, message: string): void {
  void reply.code(403).send({ error: 'forbidden', message });
}

function sendNotFound(reply: FastifyReply, message: string): void {
  void reply.code(404).send({ error: 'not_found', message });
}

// ─── Route registration ─────────────────────────────────────────────────────

/**
 * Register REST routes for all tracked tables on the Fastify instance.
 *
 * For each table, registers:
 * - GET  /{basePath}/{tableAlias}       — list with filters
 * - GET  /{basePath}/{tableAlias}/:id   — get by primary key
 * - POST /{basePath}/{tableAlias}       — insert one
 * - PATCH /{basePath}/{tableAlias}/:id  — partial update by PK
 * - DELETE /{basePath}/{tableAlias}/:id — delete by PK
 */
/**
 * Parse a default_order string like "created_at:desc" into OrderByClause[].
 */
function parseDefaultOrder(defaultOrder: string): OrderByClause[] {
  return defaultOrder.split(',').map((part) => {
    const [column, dir] = part.trim().split(':');
    return {
      column,
      direction: (dir?.toLowerCase() === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc',
    };
  });
}

/**
 * Look up an override for a table + operation combination.
 */
function findOverride(
  config: RESTConfig,
  tableName: string,
  operation: string,
): RESTEndpointOverride | undefined {
  const tableOverrides = config.overrides?.[tableName];
  if (!tableOverrides) return undefined;
  return tableOverrides.find((o) => o.operation === operation);
}

export function registerRESTRoutes(
  fastify: FastifyInstance,
  tables: TableInfo[],
  config: RESTConfig,
  deps: RESTRouterDeps,
): void {
  if (!config.autoGenerate) return;

  const basePath = config.basePath.replace(/\/$/, '');

  for (const table of tables) {
    // Look up overrides for this table
    const selectOverride = findOverride(config, table.name, 'select');
    const selectByPkOverride = findOverride(config, table.name, 'select_by_pk');
    const insertOverride = findOverride(config, table.name, 'insert_one');
    const updateOverride = findOverride(config, table.name, 'update_by_pk');
    const deleteOverride = findOverride(config, table.name, 'delete_by_pk');

    if (table.primaryKey.length === 0) {
      // Skip tables without a primary key — we can only list them
      registerListRoute(fastify, table, basePath, config, deps, selectOverride);
      registerAggregateRoute(fastify, table, basePath, config, deps);
      continue;
    }

    registerListRoute(fastify, table, basePath, config, deps, selectOverride);
    registerAggregateRoute(fastify, table, basePath, config, deps);
    registerGetByPKRoute(fastify, table, basePath, config, deps, selectByPkOverride);
    registerInsertRoute(fastify, table, basePath, config, deps, insertOverride);
    registerUpdateRoute(fastify, table, basePath, config, deps, updateOverride);
    registerDeleteRoute(fastify, table, basePath, config, deps, deleteOverride);
  }
}

// ─── Individual route handlers ───────────────────────────────────────────────

function registerListRoute(
  fastify: FastifyInstance,
  table: TableInfo,
  basePath: string,
  config: RESTConfig,
  deps: RESTRouterDeps,
  override?: RESTEndpointOverride,
): void {
  const urlName = getURLName(table);
  const path = override?.path ? `${basePath}${override.path}` : `${basePath}/${urlName}`;
  const defaultOrder = override?.defaultOrder ? parseDefaultOrder(override.defaultOrder) : undefined;

  fastify.get(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session;
    if (!session) {
      sendUnauthorized(reply, 'Authentication required');
      return;
    }

    if (!checkPermission(table, 'select', session)) {
      sendForbidden(reply, `No select permission on "${table.name}" for role "${session.role}"`);
      return;
    }

    try {
      const queryParams = request.query as Record<string, string>;

      // Validate pagination parameters
      const paginationResult = PaginationSchema.safeParse(queryParams);
      if (!paginationResult.success) {
        void reply.code(400).send({
          error: 'validation_error',
          message: paginationResult.error.issues[0].message,
        });
        return;
      }

      const parsed = parseRESTFilters(queryParams);

      // Apply default order from override if no order specified by the client
      if (defaultOrder && parsed.orderBy.length === 0) {
        parsed.orderBy = defaultOrder;
      }

      const permission = session.isAdmin ? undefined : deps.getPermission(table, session.role);

      const { sql, params } = buildSelectSQL(table, parsed, session, permission, config);
      const pool = deps.getPool('read');
      const result = await pool.query(sql, params);

      void reply.code(200).send(result.rows);
    } catch (err) {
      request.log.error({ err, table: table.name }, 'Error in list query');
      sendBadRequest(reply, err instanceof Error ? err.message : 'Query failed');
    }
  });
}

function registerAggregateRoute(
  fastify: FastifyInstance,
  table: TableInfo,
  basePath: string,
  config: RESTConfig,
  deps: RESTRouterDeps,
): void {
  const urlName = getURLName(table);
  const path = `${basePath}/${urlName}/aggregate`;

  fastify.get(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session;
    if (!session) {
      sendUnauthorized(reply, 'Authentication required');
      return;
    }

    if (!checkPermission(table, 'select', session)) {
      sendForbidden(reply, `No select permission on "${table.name}" for role "${session.role}"`);
      return;
    }

    // Check aggregation permission for non-admin roles
    if (!session.isAdmin) {
      const selectPerm = table.permissions.select[session.role];
      if (selectPerm && !selectPerm.allowAggregations) {
        sendForbidden(reply, `Aggregations not allowed for role "${session.role}" on "${table.name}"`);
        return;
      }
    }

    try {
      const queryParams = request.query as Record<string, string>;
      const parsed = parseRESTFilters(queryParams);
      const permission = session.isAdmin ? undefined : deps.getPermission(table, session.role);

      // Parse group_by parameter
      const groupByParam = queryParams['group_by'];
      let groupBy: string[] | undefined;
      if (groupByParam) {
        const selectPerm = permission?.select;
        const allowedColumns = selectPerm?.columns === '*'
          ? table.columns.map((c) => c.name)
          : (selectPerm?.columns ?? table.columns.map((c) => c.name));

        groupBy = groupByParam.split(',')
          .map((s) => s.trim())
          .filter((col) => allowedColumns.includes(col));
        if (groupBy.length === 0) groupBy = undefined;
      }

      // Build aggregate selection
      const aggregate: AggregateSelection = { count: {} };

      // Add numeric column aggregates
      const numericCols = table.columns
        .filter((c) => NUMERIC_PG_TYPES_REST.has(c.udtName))
        .map((c) => c.name);
      if (numericCols.length > 0) {
        aggregate.sum = numericCols;
        aggregate.avg = numericCols;
        aggregate.min = numericCols;
        aggregate.max = numericCols;
        aggregate.stddev = numericCols;
        aggregate.stddevPop = numericCols;
        aggregate.stddevSamp = numericCols;
        aggregate.variance = numericCols;
        aggregate.varPop = numericCols;
        aggregate.varSamp = numericCols;
      }

      const compiled = compileSelectAggregate({
        table,
        where: parsed.where,
        aggregate,
        groupBy,
        permission: permission?.select ? {
          filter: permission.select.filter,
          columns: permission.select.columns,
          limit: permission.select.limit,
        } : undefined,
        session,
      });

      const pool = deps.getPool('read');
      const result = await pool.query(compiled.sql, compiled.params);

      const row = result.rows[0] as Record<string, unknown> | undefined;

      if (groupBy) {
        // Return grouped aggregates
        const groupedData = row?.groupedAggregates as Record<string, unknown>[] ?? [];
        void reply.code(200).send(groupedData);
      } else {
        // Return standard aggregate
        void reply.code(200).send({
          aggregate: row?.aggregate ?? { count: 0 },
        });
      }
    } catch (err) {
      request.log.error({ err, table: table.name }, 'Error in aggregate query');
      sendBadRequest(reply, err instanceof Error ? err.message : 'Query failed');
    }
  });
}

/** Numeric PG types for REST aggregate detection. */
const NUMERIC_PG_TYPES_REST = new Set([
  'int2', 'int4', 'int8', 'serial', 'serial4', 'serial8', 'bigserial',
  'float4', 'float8', 'numeric', 'oid',
]);

function registerGetByPKRoute(
  fastify: FastifyInstance,
  table: TableInfo,
  basePath: string,
  config: RESTConfig,
  deps: RESTRouterDeps,
  override?: RESTEndpointOverride,
): void {
  const urlName = getURLName(table);
  const path = override?.path ? `${basePath}${override.path}` : `${basePath}/${urlName}/:id`;

  fastify.get(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session;
    if (!session) {
      sendUnauthorized(reply, 'Authentication required');
      return;
    }

    if (!checkPermission(table, 'select', session)) {
      sendForbidden(reply, `No select permission on "${table.name}" for role "${session.role}"`);
      return;
    }

    try {
      const { id } = request.params as { id: string };
      const pkValues = extractPKValues(table, id);
      const permission = session.isAdmin ? undefined : deps.getPermission(table, session.role);

      const { sql, params } = buildSelectByPKSQL(table, pkValues, session, permission);
      const pool = deps.getPool('read');
      const result = await pool.query(sql, params);

      if (result.rows.length === 0) {
        sendNotFound(reply, `Record not found in "${urlName}"`);
        return;
      }

      void reply.code(200).send(result.rows[0]);
    } catch (err) {
      request.log.error({ err, table: table.name }, 'Error in get-by-PK query');
      sendBadRequest(reply, err instanceof Error ? err.message : 'Query failed');
    }
  });
}

function registerInsertRoute(
  fastify: FastifyInstance,
  table: TableInfo,
  basePath: string,
  config: RESTConfig,
  deps: RESTRouterDeps,
  override?: RESTEndpointOverride,
): void {
  const urlName = getURLName(table);
  const path = override?.path ? `${basePath}${override.path}` : `${basePath}/${urlName}`;

  fastify.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session;
    if (!session) {
      sendUnauthorized(reply, 'Authentication required');
      return;
    }

    if (!checkPermission(table, 'insert', session)) {
      sendForbidden(reply, `No insert permission on "${table.name}" for role "${session.role}"`);
      return;
    }

    try {
      const bodyResult = MutationBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        void reply.code(400).send({
          error: 'validation_error',
          message: bodyResult.error.issues[0].message,
        });
        return;
      }
      const body = bodyResult.data;

      // Extract on_conflict from body if present
      const onConflict = body.on_conflict as
        | { constraint: string; update_columns?: string[]; where?: BoolExp }
        | undefined;

      // Remove on_conflict from the data to be inserted
      const insertData = { ...body };
      delete insertData.on_conflict;

      const permission = session.isAdmin ? undefined : deps.getPermission(table, session.role);
      const { sql, params } = buildInsertSQL(table, insertData, session, permission, onConflict);
      const pool = deps.getPool('write');
      const result = await pool.query(sql, params);

      void reply.code(201).send(result.rows[0] ?? {});
    } catch (err) {
      request.log.error({ err, table: table.name }, 'Error in insert');
      const message = err instanceof Error ? err.message : 'Insert failed';
      // Check for unique constraint violations
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        sendBadRequest(reply, `Unique constraint violation: ${message}`);
        return;
      }
      sendBadRequest(reply, message);
    }
  });
}

function registerUpdateRoute(
  fastify: FastifyInstance,
  table: TableInfo,
  basePath: string,
  config: RESTConfig,
  deps: RESTRouterDeps,
  override?: RESTEndpointOverride,
): void {
  const urlName = getURLName(table);
  const path = override?.path ? `${basePath}${override.path}` : `${basePath}/${urlName}/:id`;

  fastify.patch(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session;
    if (!session) {
      sendUnauthorized(reply, 'Authentication required');
      return;
    }

    if (!checkPermission(table, 'update', session)) {
      sendForbidden(reply, `No update permission on "${table.name}" for role "${session.role}"`);
      return;
    }

    try {
      const { id } = request.params as { id: string };
      const bodyResult = MutationBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        void reply.code(400).send({
          error: 'validation_error',
          message: bodyResult.error.issues[0].message,
        });
        return;
      }
      const body = bodyResult.data;

      const pkValues = extractPKValues(table, id);
      const permission = session.isAdmin ? undefined : deps.getPermission(table, session.role);

      const { sql, params } = buildUpdateSQL(table, pkValues, body, session, permission);
      if (!sql) {
        sendBadRequest(reply, 'No updatable columns provided');
        return;
      }

      const pool = deps.getPool('write');
      const result = await pool.query(sql, params);

      if (result.rows.length === 0) {
        sendNotFound(reply, `Record not found in "${urlName}" or permission denied`);
        return;
      }

      void reply.code(200).send(result.rows[0]);
    } catch (err) {
      request.log.error({ err, table: table.name }, 'Error in update');
      sendBadRequest(reply, err instanceof Error ? err.message : 'Update failed');
    }
  });
}

function registerDeleteRoute(
  fastify: FastifyInstance,
  table: TableInfo,
  basePath: string,
  config: RESTConfig,
  deps: RESTRouterDeps,
  override?: RESTEndpointOverride,
): void {
  const urlName = getURLName(table);
  const path = override?.path ? `${basePath}${override.path}` : `${basePath}/${urlName}/:id`;

  fastify.delete(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session;
    if (!session) {
      sendUnauthorized(reply, 'Authentication required');
      return;
    }

    if (!checkPermission(table, 'delete', session)) {
      sendForbidden(reply, `No delete permission on "${table.name}" for role "${session.role}"`);
      return;
    }

    try {
      const { id } = request.params as { id: string };
      const pkValues = extractPKValues(table, id);
      const permission = session.isAdmin ? undefined : deps.getPermission(table, session.role);

      const { sql, params } = buildDeleteSQL(table, pkValues, session, permission);
      const pool = deps.getPool('write');
      const result = await pool.query(sql, params);

      if (result.rows.length === 0) {
        sendNotFound(reply, `Record not found in "${urlName}" or permission denied`);
        return;
      }

      void reply.code(200).send({ affected_rows: result.rowCount });
    } catch (err) {
      request.log.error({ err, table: table.name }, 'Error in delete');
      sendBadRequest(reply, err instanceof Error ? err.message : 'Delete failed');
    }
  });
}
