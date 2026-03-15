/**
 * WHERE clause compiler.
 *
 * Compiles BoolExp trees (used for both user-provided query filters and
 * permission filters) into parameterized SQL WHERE clause fragments.
 */

import type { BoolExp, ColumnInfo, ColumnOperators, ComputedFieldConfig, ExistsExp, SessionVariables } from '../types.js';
import { ParamCollector, quoteIdentifier, quoteTableRef } from './utils.js';

/**
 * Threshold above which _in / _nin operators use = ANY($1) / != ALL($1)
 * array syntax instead of IN ($1, $2, ...) to reduce parameter count.
 */
export const ARRAY_ANY_THRESHOLD = 20;

// ─── Session Variable Resolution ─────────────────────────────────────────────

/**
 * Resolve a value that may be a session variable reference.
 * Session variable references are strings starting with "x-hasura-" or "X-Hasura-".
 */
function resolveValue(value: unknown, session?: SessionVariables): unknown {
  if (typeof value !== 'string') return value;

  const lower = value.toLowerCase();
  if (!lower.startsWith('x-hasura-')) return value;

  // Well-known session variables
  if (lower === 'x-hasura-role') return session?.role;
  if (lower === 'x-hasura-user-id') return session?.userId;
  if (lower === 'x-hasura-allowed-roles') return session?.allowedRoles;

  // Look up in claims map (try both original and lowercased key)
  const claimKey = lower.slice('x-hasura-'.length); // e.g. "org-id"
  if (session?.claims) {
    // Try exact match first, then lowercase
    if (claimKey in session.claims) return session.claims[claimKey];
    for (const [k, v] of Object.entries(session.claims)) {
      if (k.toLowerCase() === claimKey) return v;
    }
  }

  return undefined;
}

// ─── Operator Compilation ────────────────────────────────────────────────────

/** Alias counter for _exists subqueries within a single WHERE compilation. */
let existsAliasCounter = 0;

/** Alias counter for aggregate filter subqueries within a single WHERE compilation. */
let aggAliasCounter = 0;

/** Alias counter for relationship filter subqueries within a single WHERE compilation. */
let relAliasCounter = 0;

/**
 * Compile column-level operators into SQL fragments.
 *
 * @param columnRef    - Quoted column reference (e.g. `"t0"."tags"`).
 * @param ops          - The operator map from the BoolExp.
 * @param params       - Parameter collector.
 * @param session      - Session variables for resolving x-hasura-* references.
 * @param isArrayColumn - Whether the column is a PostgreSQL array type.
 */
function compileColumnOperators(
  columnRef: string,
  ops: ColumnOperators,
  params: ParamCollector,
  session?: SessionVariables,
  isArrayColumn = false,
): string[] {
  const clauses: string[] = [];

  if (ops._eq !== undefined) {
    const val = resolveValue(ops._eq, session);
    if (val === null) {
      clauses.push(`${columnRef} IS NULL`);
    } else {
      clauses.push(`${columnRef} = ${params.add(val)}`);
    }
  }

  if (ops._neq !== undefined) {
    const val = resolveValue(ops._neq, session);
    if (val === null) {
      clauses.push(`${columnRef} IS NOT NULL`);
    } else {
      clauses.push(`${columnRef} != ${params.add(val)}`);
    }
  }

  if (ops._gt !== undefined) {
    clauses.push(`${columnRef} > ${params.add(resolveValue(ops._gt, session))}`);
  }

  if (ops._lt !== undefined) {
    clauses.push(`${columnRef} < ${params.add(resolveValue(ops._lt, session))}`);
  }

  if (ops._gte !== undefined) {
    clauses.push(`${columnRef} >= ${params.add(resolveValue(ops._gte, session))}`);
  }

  if (ops._lte !== undefined) {
    clauses.push(`${columnRef} <= ${params.add(resolveValue(ops._lte, session))}`);
  }

  if (ops._in !== undefined) {
    const values = (ops._in as unknown[]).map((v) => resolveValue(v, session));
    if (values.length === 0) {
      // IN with empty list => always false
      clauses.push('FALSE');
    } else if (isArrayColumn) {
      // For array columns, each value in _in is itself an array.
      // Always use IN ($1, $2, ...) form — the pg driver serializes each
      // JS array into a PG array literal.
      clauses.push(`${columnRef} IN ${params.addMany(values)}`);
    } else if (values.length > ARRAY_ANY_THRESHOLD) {
      // For large IN lists, use = ANY($1) with a single array parameter
      // instead of IN ($1, $2, ...) to reduce parameter count
      clauses.push(`${columnRef} = ANY(${params.addArray(values)})`);
    } else {
      clauses.push(`${columnRef} IN ${params.addMany(values)}`);
    }
  }

  if (ops._nin !== undefined) {
    const values = (ops._nin as unknown[]).map((v) => resolveValue(v, session));
    if (values.length === 0) {
      // NOT IN with empty list => always true (no-op)
      clauses.push('TRUE');
    } else if (isArrayColumn) {
      // For array columns, always use NOT IN ($1, $2, ...) form
      clauses.push(`${columnRef} NOT IN ${params.addMany(values)}`);
    } else if (values.length > ARRAY_ANY_THRESHOLD) {
      // For large NOT IN lists, use != ALL($1) with a single array parameter
      clauses.push(`${columnRef} != ALL(${params.addArray(values)})`);
    } else {
      clauses.push(`${columnRef} NOT IN ${params.addMany(values)}`);
    }
  }

  if (ops._isNull !== undefined) {
    clauses.push(ops._isNull ? `${columnRef} IS NULL` : `${columnRef} IS NOT NULL`);
  }

  // ── Text operators ──

  if (ops._like !== undefined) {
    clauses.push(`${columnRef} LIKE ${params.add(resolveValue(ops._like, session))}`);
  }
  if (ops._nlike !== undefined) {
    clauses.push(`${columnRef} NOT LIKE ${params.add(resolveValue(ops._nlike, session))}`);
  }
  if (ops._ilike !== undefined) {
    clauses.push(`${columnRef} ILIKE ${params.add(resolveValue(ops._ilike, session))}`);
  }
  if (ops._nilike !== undefined) {
    clauses.push(`${columnRef} NOT ILIKE ${params.add(resolveValue(ops._nilike, session))}`);
  }
  if (ops._similar !== undefined) {
    clauses.push(`${columnRef} SIMILAR TO ${params.add(resolveValue(ops._similar, session))}`);
  }
  if (ops._nsimilar !== undefined) {
    clauses.push(
      `${columnRef} NOT SIMILAR TO ${params.add(resolveValue(ops._nsimilar, session))}`,
    );
  }
  if (ops._regex !== undefined) {
    clauses.push(`${columnRef} ~ ${params.add(resolveValue(ops._regex, session))}`);
  }
  if (ops._nregex !== undefined) {
    clauses.push(`${columnRef} !~ ${params.add(resolveValue(ops._nregex, session))}`);
  }
  if (ops._iregex !== undefined) {
    clauses.push(`${columnRef} ~* ${params.add(resolveValue(ops._iregex, session))}`);
  }
  if (ops._niregex !== undefined) {
    clauses.push(`${columnRef} !~* ${params.add(resolveValue(ops._niregex, session))}`);
  }

  // ── JSONB cast expression ──

  if (ops._cast !== undefined) {
    const castOps = (ops._cast as { String?: ColumnOperators }).String;
    if (castOps) {
      const castRef = `(${columnRef})::text`;
      const castClauses = compileColumnOperators(castRef, castOps, params, session);
      clauses.push(...castClauses);
    }
  }

  // ── Containment operators (@> / <@) ──
  // For array columns: native PG array containment (no JSON serialization).
  // For JSONB columns: JSON-serialize the value and cast to ::jsonb.

  if (ops._contains !== undefined) {
    if (isArrayColumn) {
      clauses.push(
        `${columnRef} @> ${params.add(resolveValue(ops._contains, session))}`,
      );
    } else {
      clauses.push(
        `${columnRef} @> ${params.add(JSON.stringify(resolveValue(ops._contains, session)))}::jsonb`,
      );
    }
  }
  if (ops._containedIn !== undefined) {
    if (isArrayColumn) {
      clauses.push(
        `${columnRef} <@ ${params.add(resolveValue(ops._containedIn, session))}`,
      );
    } else {
      clauses.push(
        `${columnRef} <@ ${params.add(JSON.stringify(resolveValue(ops._containedIn, session)))}::jsonb`,
      );
    }
  }

  // ── JSONB-only operators ──

  if (ops._hasKey !== undefined) {
    clauses.push(
      `${columnRef} ? ${params.add(resolveValue(ops._hasKey, session))}`,
    );
  }
  if (ops._hasKeysAny !== undefined) {
    clauses.push(
      `${columnRef} ?| ${params.add(ops._hasKeysAny)}`,
    );
  }
  if (ops._hasKeysAll !== undefined) {
    clauses.push(
      `${columnRef} ?& ${params.add(ops._hasKeysAll)}`,
    );
  }

  return clauses;
}

// ─── Boolean Expression Compiler ─────────────────────────────────────────────

/**
 * Recursively compile a BoolExp into a SQL WHERE fragment.
 * Returns an empty string for empty/null/undefined filters.
 */
function compileBoolExp(
  exp: BoolExp,
  params: ParamCollector,
  tableAlias: string,
  session?: SessionVariables,
  columnLookup?: Map<string, ColumnInfo>,
  computedFields?: ComputedFieldConfig[],
): string {
  if (!exp || typeof exp !== 'object') return '';

  const keys = Object.keys(exp);
  if (keys.length === 0) return '';

  // ── Logical operators ──

  if ('_and' in exp) {
    const andExp = exp as { _and: BoolExp[] };
    const parts = andExp._and
      .map((sub) => compileBoolExp(sub, params, tableAlias, session, columnLookup, computedFields))
      .filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return `(${parts.join(' AND ')})`;
  }

  if ('_or' in exp) {
    const orExp = exp as { _or: BoolExp[] };
    const parts = orExp._or
      .map((sub) => compileBoolExp(sub, params, tableAlias, session, columnLookup, computedFields))
      .filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return `(${parts.join(' OR ')})`;
  }

  if ('_not' in exp) {
    const notExp = exp as { _not: BoolExp };
    const inner = compileBoolExp(notExp._not, params, tableAlias, session, columnLookup, computedFields);
    if (!inner) return '';
    return `NOT (${inner})`;
  }

  // ── _exists subquery ──

  if ('_exists' in exp) {
    const existsExp = exp as { _exists: ExistsExp };
    const subAlias = `_exists_${existsAliasCounter++}`;
    const subTable = quoteTableRef(
      existsExp._exists._table.schema,
      existsExp._exists._table.name,
    );
    const subWhere = compileBoolExp(
      existsExp._exists._where,
      params,
      subAlias,
      session,
    );
    const whereClause = subWhere ? ` WHERE ${subWhere}` : '';
    return `EXISTS (SELECT 1 FROM ${subTable} ${quoteIdentifier(subAlias)}${whereClause})`;
  }

  // ── _aggregateFilter (internal, emitted by resolver's remapBoolExp) ──

  if ('_aggregateFilter' in exp) {
    const agg = (exp as Record<string, unknown>)['_aggregateFilter'] as {
      function: string;
      arguments?: string[];
      distinct?: boolean;
      filter?: BoolExp;
      predicate: Record<string, unknown>;
      columnMapping: Record<string, string>;
      remoteSchema: string;
      remoteTable: string;
    };

    const subAlias = `_agg_${aggAliasCounter++}`;

    // Build join conditions from column mapping
    const joinConds = Object.entries(agg.columnMapping)
      .map(([local, remote]) =>
        `${quoteIdentifier(subAlias)}.${quoteIdentifier(remote)} = ${quoteIdentifier(tableAlias)}.${quoteIdentifier(local)}`,
      )
      .join(' AND ');

    // Build aggregate expression
    let aggExpr: string;
    if (agg.function === 'count') {
      if (agg.arguments && agg.arguments.length > 0) {
        const cols = agg.arguments.map((c) => `${quoteIdentifier(subAlias)}.${quoteIdentifier(c)}`).join(', ');
        aggExpr = agg.distinct ? `COUNT(DISTINCT ${cols})` : `COUNT(${cols})`;
      } else {
        aggExpr = agg.distinct ? 'COUNT(DISTINCT *)' : 'COUNT(*)';
      }
    } else {
      aggExpr = 'COUNT(*)';
    }

    // Build optional sub-filter
    let filterClause = '';
    if (agg.filter) {
      const filterSQL = compileBoolExp(agg.filter, params, subAlias, session);
      if (filterSQL) filterClause = ` AND ${filterSQL}`;
    }

    // Build correlated subquery
    const subquery = `(SELECT ${aggExpr} FROM ${quoteTableRef(agg.remoteSchema, agg.remoteTable)} ${quoteIdentifier(subAlias)} WHERE ${joinConds}${filterClause})`;

    // Apply predicate using existing compileColumnOperators
    const predClauses = compileColumnOperators(subquery, agg.predicate as ColumnOperators, params, session);
    if (predClauses.length === 0) return '';
    return predClauses.join(' AND ');
  }

  // ── _relationshipFilter (internal, emitted by resolver's remapBoolExp) ──

  if ('_relationshipFilter' in exp) {
    const relFilter = (exp as Record<string, unknown>)['_relationshipFilter'] as {
      columnMapping: Record<string, string>;
      remoteSchema: string;
      remoteTable: string;
      where?: BoolExp;
    };

    const subAlias = `_rel_${relAliasCounter++}`;

    // Build join conditions from column mapping
    const joinConds = Object.entries(relFilter.columnMapping)
      .map(([local, remote]) =>
        `${quoteIdentifier(subAlias)}.${quoteIdentifier(remote)} = ${quoteIdentifier(tableAlias)}.${quoteIdentifier(local)}`,
      )
      .join(' AND ');

    // Build optional user filter
    let filterClause = '';
    if (relFilter.where) {
      const filterSQL = compileBoolExp(relFilter.where, params, subAlias, session);
      if (filterSQL) filterClause = ` AND ${filterSQL}`;
    }

    return `EXISTS (SELECT 1 FROM ${quoteTableRef(relFilter.remoteSchema, relFilter.remoteTable)} ${quoteIdentifier(subAlias)} WHERE ${joinConds}${filterClause})`;
  }

  // ── Column-level expressions (implicit AND across all keys) ──

  // Build a lookup map for computed fields by snake_case name
  const cfLookup = computedFields
    ? new Map(computedFields.map((cf) => [cf.name, cf]))
    : undefined;

  const clauses: string[] = [];

  for (const key of keys) {
    const value = (exp as Record<string, unknown>)[key];

    // Check if this key is a computed field — if so, use function call as LHS
    const cfConfig = cfLookup?.get(key);
    let columnRef: string;
    if (cfConfig) {
      const fnSchema = cfConfig.function.schema ?? 'public';
      columnRef = `${quoteIdentifier(fnSchema)}.${quoteIdentifier(cfConfig.function.name)}(${quoteIdentifier(tableAlias)})`;
    } else {
      columnRef = `${quoteIdentifier(tableAlias)}.${quoteIdentifier(key)}`;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Check if the value has any known column operator keys
      const valueKeys = Object.keys(value);
      const hasColumnOps = valueKeys.some((k) => k.startsWith('_'));

      if (hasColumnOps) {
        // Determine if this column is a PG array type
        const colInfo = columnLookup?.get(key);
        const isArrayColumn = colInfo?.isArray ?? false;

        // It's a ColumnOperators object
        const opClauses = compileColumnOperators(
          columnRef,
          value as ColumnOperators,
          params,
          session,
          isArrayColumn,
        );
        clauses.push(...opClauses);
      } else {
        // It's a nested BoolExp for relationship traversal — not handled
        // at this level (relationship traversal needs schema context).
        // For now, treat as nested column filters.
        const nested = compileBoolExp(value as BoolExp, params, tableAlias, session, columnLookup, computedFields);
        if (nested) clauses.push(nested);
      }
    }
  }

  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  return `(${clauses.join(' AND ')})`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compile a BoolExp into a SQL WHERE clause fragment (without the WHERE keyword).
 *
 * @param boolExp       - The boolean expression tree to compile.
 * @param params        - Parameter collector for tracking $N placeholders.
 * @param tableAlias    - The table alias to prefix column references with.
 * @param session       - Session variables for resolving x-hasura-* references.
 * @param columnLookup  - Optional map of column name → ColumnInfo for array detection.
 * @param computedFields - Optional array of computed field configs for this table.
 *   When a BoolExp key matches a computed field name, the compiler emits a
 *   function call (e.g. `"public"."fn"("t0")`) instead of a column reference.
 * @returns The compiled SQL string, or empty string for empty/null filters.
 */
export function compileWhere(
  boolExp: BoolExp | undefined | null,
  params: ParamCollector,
  tableAlias: string,
  session?: SessionVariables,
  columnLookup?: Map<string, ColumnInfo>,
  computedFields?: ComputedFieldConfig[],
): string {
  if (!boolExp) return '';
  // Reset alias counters for each top-level compilation
  existsAliasCounter = 0;
  aggAliasCounter = 0;
  relAliasCounter = 0;
  return compileBoolExp(boolExp, params, tableAlias, session, columnLookup, computedFields);
}
