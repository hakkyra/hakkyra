/**
 * INSERT query compiler.
 *
 * Compiles INSERT queries with:
 * - Column permission enforcement (reject disallowed columns)
 * - Column presets (inject session-variable-based default values)
 * - Post-insert check constraints via CTE validation
 * - RETURNING clause shaped as json_build_object for GraphQL response
 * - Automatic chunking for large batches to respect PostgreSQL parameter limits
 * - UNNEST optimization for very large homogeneous inserts (500+ rows)
 */

import type {
  BoolExp,
  CompiledFilter,
  CompiledQuery,
  SessionVariables,
  TableInfo,
} from '../types.js';
import { ParamCollector, quoteIdentifier, quoteTableRef } from './utils.js';
import { compileWhere } from './where.js';
import { AliasCounter, filterColumns, buildJsonFields } from './select.js';
import type { RelationshipSelection, ComputedFieldSelection, SetReturningComputedFieldSelection } from './select.js';
import { toCamelCase } from '../schema/type-builder.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** PostgreSQL hard limit on parameters per query. */
export const PG_MAX_PARAMS = 65535;

/** Default chunk size for batched inserts. */
export const DEFAULT_BATCH_CHUNK_SIZE = 100;

/** Threshold above which UNNEST optimization is used instead of multi-row VALUES. */
export const UNNEST_THRESHOLD = 500;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InsertOneOptions {
  table: TableInfo;
  /** The object to insert: { column_name: value } */
  object: Record<string, unknown>;
  /** Columns to return in the response */
  returningColumns: string[];
  /** Relationships to include in the RETURNING clause */
  returningRelationships?: RelationshipSelection[];
  /** Computed fields to include in the RETURNING clause */
  returningComputedFields?: ComputedFieldSelection[];
  /** Set-returning computed fields to include in the RETURNING clause */
  returningSetReturningComputedFields?: SetReturningComputedFieldSelection[];
  /** JSONB path arguments for RETURNING fields */
  returningJsonbPaths?: Map<string, string>;
  /** Conflict handling */
  onConflict?: OnConflictClause;
  permission?: {
    check: CompiledFilter;
    columns: string[] | '*';
    presets?: Record<string, string>;
  };
  session: SessionVariables;
}

export interface InsertOptions {
  table: TableInfo;
  /** Array of objects to insert */
  objects: Record<string, unknown>[];
  /** Columns to return in the response */
  returningColumns: string[];
  /** Relationships to include in the RETURNING clause */
  returningRelationships?: RelationshipSelection[];
  /** Computed fields to include in the RETURNING clause */
  returningComputedFields?: ComputedFieldSelection[];
  /** Set-returning computed fields to include in the RETURNING clause */
  returningSetReturningComputedFields?: SetReturningComputedFieldSelection[];
  /** JSONB path arguments for RETURNING fields */
  returningJsonbPaths?: Map<string, string>;
  /** Conflict handling */
  onConflict?: OnConflictClause;
  permission?: {
    check: CompiledFilter;
    columns: string[] | '*';
    presets?: Record<string, string>;
  };
  session: SessionVariables;
  /** Override default chunk size for large batches. */
  chunkSize?: number;
  /** Override UNNEST threshold (set to Infinity to disable UNNEST). */
  unnestThreshold?: number;
}

export interface OnConflictClause {
  constraint: string;
  updateColumns: string[];
  where?: BoolExp;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a preset value. If it's a session variable reference (x-hasura-*),
 * resolve it from the session. Otherwise use the literal value.
 */
function resolvePreset(value: string, session: SessionVariables): unknown {
  const lower = value.toLowerCase();
  if (!lower.startsWith('x-hasura-')) return value;

  if (lower === 'x-hasura-role') return session.role;
  if (lower === 'x-hasura-user-id') return session.userId;

  const claimKey = lower.slice('x-hasura-'.length);
  if (session.claims) {
    if (claimKey in session.claims) return session.claims[claimKey];
    for (const [k, v] of Object.entries(session.claims)) {
      if (k.toLowerCase() === claimKey) return v;
    }
  }

  return undefined;
}

/**
 * Filter columns based on permission and apply presets.
 * Returns the final column-value pairs for the INSERT.
 *
 * Preset columns cannot be provided by the caller — they are always set from
 * the permission configuration (session variables or literal values).
 */
function prepareInsertData(
  obj: Record<string, unknown>,
  table: TableInfo,
  permission: InsertOneOptions['permission'],
  session: SessionVariables,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const tableColumnNames = new Set(table.columns.map((c) => c.name));
  const allowedColumns = permission?.columns;
  const presets = permission?.presets;

  // Add user-provided columns (filtered by permissions)
  for (const [col, val] of Object.entries(obj)) {
    if (!tableColumnNames.has(col)) continue; // skip unknown columns
    // Reject user input for preset columns — presets are authoritative
    if (presets && col in presets) {
      throw new Error(`Column "${col}" has a preset and cannot be provided for insert on table "${table.schema}"."${table.name}"`);
    }
    if (allowedColumns && allowedColumns !== '*' && !allowedColumns.includes(col)) {
      throw new Error(`Column "${col}" is not allowed for insert on table "${table.schema}"."${table.name}"`);
    }
    result[col] = val;
  }

  // Apply presets
  if (presets) {
    for (const [col, presetValue] of Object.entries(presets)) {
      result[col] = resolvePreset(presetValue, session);
    }
  }

  return result;
}

// ─── ON CONFLICT Clause Builder ───────────────────────────────────────────────

/**
 * Build the ON CONFLICT SQL fragment from an OnConflictClause.
 * Handles DO UPDATE SET ... WHERE ... and DO NOTHING.
 */
function buildOnConflictSQL(
  oc: OnConflictClause,
  params: ParamCollector,
  table: TableInfo,
  session: SessionVariables,
): string {
  const constraintRef = quoteIdentifier(oc.constraint);

  if (oc.updateColumns.length === 0) {
    return `\nON CONFLICT ON CONSTRAINT ${constraintRef} DO NOTHING`;
  }

  const updates = oc.updateColumns.map(
    (c) => `${quoteIdentifier(c)} = EXCLUDED.${quoteIdentifier(c)}`,
  ).join(', ');

  let whereClause = '';
  if (oc.where) {
    // Compile the where clause — use the table name as alias since DO UPDATE
    // SET ... WHERE references the target table columns directly
    const insertColumnLookup = new Map(table.columns.map(c => [c.name, c]));
    const whereSQL = compileWhere(oc.where, params, table.name, session, insertColumnLookup);
    if (whereSQL) {
      whereClause = ` WHERE ${whereSQL}`;
    }
  }

  return `\nON CONFLICT ON CONSTRAINT ${constraintRef} DO UPDATE SET ${updates}${whereClause}`;
}

// ─── Returning Fields Builder ────────────────────────────────────────────────

/**
 * Build json_build_object fields for the RETURNING clause, including
 * relationship subqueries when requested.
 *
 * When relationships are present, uses buildJsonFields from the SELECT compiler
 * to generate correlated subqueries alongside scalar column fields.
 */
function buildReturningFields(
  table: TableInfo,
  returningColumns: string[],
  alias: string,
  params: ParamCollector,
  session: SessionVariables,
  relationships?: RelationshipSelection[],
  jsonbPaths?: Map<string, string>,
  computedFields?: ComputedFieldSelection[],
  setReturningComputedFields?: SetReturningComputedFieldSelection[],
): string {
  const tableColumnNames = new Set(table.columns.map((c) => c.name));
  const validReturning = returningColumns.filter((c) => tableColumnNames.has(c));

  const hasRelationships = relationships && relationships.length > 0;
  const hasJsonbPaths = jsonbPaths && jsonbPaths.size > 0;
  const hasComputedFields = computedFields && computedFields.length > 0;
  const hasSetReturningComputedFields = setReturningComputedFields && setReturningComputedFields.length > 0;

  if (hasRelationships || hasJsonbPaths || hasComputedFields || hasSetReturningComputedFields) {
    // Use buildJsonFields from SELECT compiler — it handles scalar columns,
    // relationship subqueries, computed fields, and JSONB path extraction in one pass
    const columns = filterColumns(validReturning, table);
    const aliasCounter = new AliasCounter();
    return buildJsonFields(columns, alias, relationships, params, session, aliasCounter, computedFields, setReturningComputedFields, jsonbPaths, table.customColumnNames);
  }

  // No relationships or jsonb paths — simple column list
  return validReturning.map(
    (c) => `'${c}', ${quoteIdentifier(alias)}.${quoteIdentifier(c)}`,
  ).join(', ');
}

// ─── INSERT ONE ──────────────────────────────────────────────────────────────

/**
 * Compile an INSERT for a single row.
 *
 * If a permission check is provided, uses a CTE pattern:
 *   WITH "_inserted" AS (INSERT ... RETURNING *)
 *   SELECT ... FROM "_inserted"
 *   WHERE <check_condition>
 *
 * If the check fails (no rows returned), the caller should raise a permission error.
 */
export function compileInsertOne(opts: InsertOneOptions): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  // Prepare data with permissions and presets
  const data = prepareInsertData(opts.object, opts.table, opts.permission, opts.session);

  const columnNames = Object.keys(data);
  if (columnNames.length === 0) {
    throw new Error(`No columns to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  const quotedColumns = columnNames.map(quoteIdentifier).join(', ');
  const valuePlaceholders = columnNames.map((col) => params.add(data[col])).join(', ');

  // Build ON CONFLICT clause
  const onConflictClause = opts.onConflict
    ? buildOnConflictSQL(opts.onConflict, params, opts.table, opts.session)
    : '';

  const hasRelationships = opts.returningRelationships && opts.returningRelationships.length > 0;
  const hasJsonbPaths = opts.returningJsonbPaths && opts.returningJsonbPaths.size > 0;
  const hasComputedFields = opts.returningComputedFields && opts.returningComputedFields.length > 0;
  const hasSetReturningComputedFields = opts.returningSetReturningComputedFields && opts.returningSetReturningComputedFields.length > 0;

  // Check if we need a CTE (permission check OR relationships/computedFields/jsonbPaths in RETURNING)
  if (opts.permission?.check || hasRelationships || hasJsonbPaths || hasComputedFields || hasSetReturningComputedFields) {
    // Build RETURNING fields with potential relationship subqueries, computed fields, and JSONB path extraction
    const returningFields = buildReturningFields(
      opts.table,
      opts.returningColumns,
      '_inserted',
      params,
      opts.session,
      opts.returningRelationships,
      opts.returningJsonbPaths,
      opts.returningComputedFields,
      opts.returningSetReturningComputedFields,
    );

    let checkWhere = '';
    if (opts.permission?.check) {
      const checkResult = opts.permission.check.toSQL(
        opts.session,
        params.getOffset(),
        '_inserted',
      );
      // Add check params
      for (const p of checkResult.params) {
        params.add(p);
      }
      checkWhere = checkResult.sql ? ` WHERE ${checkResult.sql}` : '';
    }

    const sql = [
      `WITH "_inserted" AS (`,
      `  INSERT INTO ${tableRef} (${quotedColumns})`,
      `  VALUES (${valuePlaceholders})${onConflictClause}`,
      `  RETURNING *`,
      `)`,
      `SELECT json_build_object(${returningFields}) AS "data"`,
      `FROM "_inserted"`,
      checkWhere ? checkWhere : null,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple insert without check or relationships — RETURNING references bare column names
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));
  const simpleReturningFields = validReturning.map(
    (c) => `'${toCamelCase(c)}', ${quoteIdentifier(c)}`,
  ).join(', ');
  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${simpleReturningFields}) AS "data"`
    : '';

  const sql = [
    `INSERT INTO ${tableRef} (${quotedColumns})`,
    `VALUES (${valuePlaceholders})`,
  ].join('\n') + onConflictClause + returningClause;

  return { sql, params: params.getParams() };
}

// ─── UNNEST Optimization ──────────────────────────────────────────────────

/**
 * Map a PostgreSQL udt_name to the PG cast type used in UNNEST.
 * Falls back to 'text' for unknown types.
 */
function pgCastType(udtName: string): string {
  const castMap: Record<string, string> = {
    int2: 'int2',
    int4: 'int4',
    int8: 'int8',
    float4: 'float4',
    float8: 'float8',
    numeric: 'numeric',
    bool: 'boolean',
    text: 'text',
    varchar: 'text',
    char: 'text',
    name: 'text',
    uuid: 'uuid',
    json: 'json',
    jsonb: 'jsonb',
    date: 'date',
    time: 'time',
    timetz: 'timetz',
    timestamp: 'timestamp',
    timestamptz: 'timestamptz',
    interval: 'interval',
    bytea: 'bytea',
    inet: 'inet',
    cidr: 'cidr',
    macaddr: 'macaddr',
  };
  return castMap[udtName] ?? 'text';
}

/**
 * Check if all objects have the same set of columns (homogeneous).
 * UNNEST requires all rows to provide the same columns.
 */
function isHomogeneous(objects: Record<string, unknown>[], columnNames: string[]): boolean {
  for (const obj of objects) {
    for (const col of columnNames) {
      if (!(col in obj)) return false;
    }
  }
  return true;
}

/**
 * Compile a bulk INSERT using the UNNEST optimization.
 *
 * Uses: INSERT INTO ... SELECT * FROM UNNEST($1::type[], $2::type[], ...)
 * This is more efficient than multi-row VALUES for large datasets (500+ rows)
 * because it uses only N parameters (one per column) instead of N*M parameters.
 */
function compileInsertUnnest(
  opts: InsertOptions,
  preparedObjects: Record<string, unknown>[],
  columnNames: string[],
): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  const quotedColumns = columnNames.map(quoteIdentifier).join(', ');

  // Build column arrays and UNNEST expressions
  const unnestParts: string[] = [];
  for (const col of columnNames) {
    const colInfo = opts.table.columns.find((c) => c.name === col);
    const castType = colInfo ? pgCastType(colInfo.udtName) : 'text';
    const values = preparedObjects.map((obj) => obj[col]);
    const placeholder = params.add(values);
    unnestParts.push(`${placeholder}::${castType}[]`);
  }

  // Build ON CONFLICT clause
  const onConflictClause = opts.onConflict
    ? buildOnConflictSQL(opts.onConflict, params, opts.table, opts.session)
    : '';

  const hasRelationships = opts.returningRelationships && opts.returningRelationships.length > 0;
  const hasJsonbPaths = opts.returningJsonbPaths && opts.returningJsonbPaths.size > 0;
  const hasComputedFields = opts.returningComputedFields && opts.returningComputedFields.length > 0;
  const hasSetReturningComputedFields = opts.returningSetReturningComputedFields && opts.returningSetReturningComputedFields.length > 0;

  if (opts.permission?.check || hasRelationships || hasJsonbPaths || hasComputedFields || hasSetReturningComputedFields) {
    const returningFields = buildReturningFields(
      opts.table,
      opts.returningColumns,
      '_inserted',
      params,
      opts.session,
      opts.returningRelationships,
      opts.returningJsonbPaths,
      opts.returningComputedFields,
      opts.returningSetReturningComputedFields,
    );

    let checkWhere = '';
    if (opts.permission?.check) {
      const checkResult = opts.permission.check.toSQL(
        opts.session,
        params.getOffset(),
        '_inserted',
      );
      for (const p of checkResult.params) {
        params.add(p);
      }
      checkWhere = checkResult.sql ? ` WHERE ${checkResult.sql}` : '';
    }

    const sql = [
      `WITH "_inserted" AS (`,
      `  INSERT INTO ${tableRef} (${quotedColumns})`,
      `  SELECT * FROM UNNEST(${unnestParts.join(', ')})${onConflictClause}`,
      `  RETURNING *`,
      `)`,
      `SELECT coalesce(json_agg(json_build_object(${returningFields})), '[]'::json) AS "data"`,
      `FROM "_inserted"`,
      checkWhere ? checkWhere : null,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple UNNEST insert without check or relationships
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));
  const simpleReturningFields = validReturning.map(
    (c) => `'${toCamelCase(c)}', ${quoteIdentifier(c)}`,
  ).join(', ');

  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${simpleReturningFields}) AS "data"`
    : '';

  const sql = [
    `INSERT INTO ${tableRef} (${quotedColumns})`,
    `SELECT * FROM UNNEST(${unnestParts.join(', ')})`,
  ].join('\n') + onConflictClause + returningClause;

  return { sql, params: params.getParams() };
}

// ─── BULK INSERT ─────────────────────────────────────────────────────────

/**
 * Compile a single-chunk bulk INSERT using multi-row VALUES.
 * This is the internal workhorse used by compileInsert for each chunk.
 */
function compileInsertChunk(
  opts: InsertOptions,
  preparedObjects: Record<string, unknown>[],
  columnNames: string[],
): CompiledQuery {
  const params = new ParamCollector();
  const tableRef = quoteTableRef(opts.table.schema, opts.table.name);

  const quotedColumns = columnNames.map(quoteIdentifier).join(', ');

  // Build VALUES rows
  const valueRows = preparedObjects.map((obj) => {
    const values = columnNames.map((col) => {
      if (col in obj) {
        return params.add(obj[col]);
      }
      return 'DEFAULT';
    });
    return `(${values.join(', ')})`;
  });

  // Build ON CONFLICT clause
  const onConflictClause = opts.onConflict
    ? buildOnConflictSQL(opts.onConflict, params, opts.table, opts.session)
    : '';

  const hasRelationships = opts.returningRelationships && opts.returningRelationships.length > 0;
  const hasJsonbPaths = opts.returningJsonbPaths && opts.returningJsonbPaths.size > 0;
  const hasComputedFields = opts.returningComputedFields && opts.returningComputedFields.length > 0;
  const hasSetReturningComputedFields = opts.returningSetReturningComputedFields && opts.returningSetReturningComputedFields.length > 0;

  // Check if we need a CTE (permission check OR relationships/computedFields/jsonbPaths in RETURNING)
  if (opts.permission?.check || hasRelationships || hasJsonbPaths || hasComputedFields || hasSetReturningComputedFields) {
    const returningFields = buildReturningFields(
      opts.table,
      opts.returningColumns,
      '_inserted',
      params,
      opts.session,
      opts.returningRelationships,
      opts.returningJsonbPaths,
      opts.returningComputedFields,
      opts.returningSetReturningComputedFields,
    );

    let checkWhere = '';
    if (opts.permission?.check) {
      const checkResult = opts.permission.check.toSQL(
        opts.session,
        params.getOffset(),
        '_inserted',
      );
      for (const p of checkResult.params) {
        params.add(p);
      }
      checkWhere = checkResult.sql ? ` WHERE ${checkResult.sql}` : '';
    }

    const sql = [
      `WITH "_inserted" AS (`,
      `  INSERT INTO ${tableRef} (${quotedColumns})`,
      `  VALUES ${valueRows.join(',\n  ')}${onConflictClause}`,
      `  RETURNING *`,
      `)`,
      `SELECT coalesce(json_agg(json_build_object(${returningFields})), '[]'::json) AS "data"`,
      `FROM "_inserted"`,
      checkWhere ? checkWhere : null,
    ].filter(Boolean).join('\n');

    return { sql, params: params.getParams() };
  }

  // Simple bulk insert without check or relationships
  const tableColumnNames = new Set(opts.table.columns.map((c) => c.name));
  const validReturning = opts.returningColumns.filter((c) => tableColumnNames.has(c));
  const simpleReturningFields = validReturning.map(
    (c) => `'${toCamelCase(c)}', ${quoteIdentifier(c)}`,
  ).join(', ');

  const returningClause = validReturning.length > 0
    ? `\nRETURNING json_build_object(${simpleReturningFields}) AS "data"`
    : '';

  const sql = [
    `INSERT INTO ${tableRef} (${quotedColumns})`,
    `VALUES ${valueRows.join(',\n')}`,
  ].join('\n') + onConflictClause + returningClause;

  return { sql, params: params.getParams() };
}

/**
 * Calculate the maximum number of rows per chunk to stay within PG_MAX_PARAMS.
 */
function calculateChunkSize(numColumns: number, requestedChunkSize: number): number {
  if (numColumns === 0) return requestedChunkSize;
  const maxRowsByParams = Math.floor(PG_MAX_PARAMS / numColumns);
  return Math.min(requestedChunkSize, maxRowsByParams);
}

/**
 * Compile a bulk INSERT for multiple rows.
 *
 * Optimizations:
 * - Automatic chunking when approaching PostgreSQL's 65535 parameter limit
 * - UNNEST optimization for large homogeneous batches (500+ rows, configurable)
 *
 * All objects must be normalized to the same column set (union of all keys).
 * Missing columns are filled with DEFAULT.
 *
 * When chunking is needed (batch too large for a single query), returns the
 * first chunk query. For multi-chunk execution, use compileInsertBatch.
 */
export function compileInsert(opts: InsertOptions): CompiledQuery {
  if (opts.objects.length === 0) {
    throw new Error(`No objects to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  // Prepare all objects
  const preparedObjects = opts.objects.map((obj) =>
    prepareInsertData(obj, opts.table, opts.permission, opts.session),
  );

  // Collect the union of all column names (order matters for consistency)
  const columnSet = new Set<string>();
  for (const obj of preparedObjects) {
    for (const col of Object.keys(obj)) {
      columnSet.add(col);
    }
  }
  const columnNames = [...columnSet];

  if (columnNames.length === 0) {
    throw new Error(`No columns to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  const unnestThreshold = opts.unnestThreshold ?? UNNEST_THRESHOLD;

  // UNNEST optimization for large homogeneous inserts
  if (
    preparedObjects.length >= unnestThreshold &&
    isHomogeneous(preparedObjects, columnNames)
  ) {
    return compileInsertUnnest(opts, preparedObjects, columnNames);
  }

  // For single-query path, check if we need chunking
  const totalParams = preparedObjects.length * columnNames.length;
  if (totalParams <= PG_MAX_PARAMS) {
    // Fits in a single query
    return compileInsertChunk(opts, preparedObjects, columnNames);
  }

  // Too many params — compile just the first valid chunk.
  // The caller should use compileInsertBatch for multi-chunk execution.
  const chunkSize = calculateChunkSize(columnNames.length, opts.chunkSize ?? DEFAULT_BATCH_CHUNK_SIZE);
  const chunk = preparedObjects.slice(0, chunkSize);
  return compileInsertChunk(opts, chunk, columnNames);
}

/**
 * Compile a bulk INSERT into multiple chunked queries.
 *
 * Returns an array of CompiledQuery objects, each staying within PostgreSQL's
 * parameter limit. The caller should execute them sequentially within a
 * transaction.
 *
 * Uses UNNEST optimization for large homogeneous batches when applicable.
 */
export function compileInsertBatch(opts: InsertOptions): CompiledQuery[] {
  if (opts.objects.length === 0) {
    throw new Error(`No objects to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  // Prepare all objects
  const preparedObjects = opts.objects.map((obj) =>
    prepareInsertData(obj, opts.table, opts.permission, opts.session),
  );

  // Collect the union of all column names
  const columnSet = new Set<string>();
  for (const obj of preparedObjects) {
    for (const col of Object.keys(obj)) {
      columnSet.add(col);
    }
  }
  const columnNames = [...columnSet];

  if (columnNames.length === 0) {
    throw new Error(`No columns to insert into "${opts.table.schema}"."${opts.table.name}"`);
  }

  const unnestThreshold = opts.unnestThreshold ?? UNNEST_THRESHOLD;

  // UNNEST optimization — uses only N params (one per column, as arrays),
  // so a single query can handle any batch size
  if (
    preparedObjects.length >= unnestThreshold &&
    isHomogeneous(preparedObjects, columnNames)
  ) {
    return [compileInsertUnnest(opts, preparedObjects, columnNames)];
  }

  // Calculate chunk size
  const chunkSize = calculateChunkSize(
    columnNames.length,
    opts.chunkSize ?? DEFAULT_BATCH_CHUNK_SIZE,
  );

  const queries: CompiledQuery[] = [];
  for (let i = 0; i < preparedObjects.length; i += chunkSize) {
    const chunk = preparedObjects.slice(i, i + chunkSize);
    queries.push(compileInsertChunk(opts, chunk, columnNames));
  }

  return queries;
}
