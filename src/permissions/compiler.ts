/**
 * Permission filter compiler.
 *
 * Compiles Hasura-compatible BoolExp objects into parameterized SQL WHERE clauses.
 * All values are parameterized ($1, $2, ...) to prevent SQL injection.
 *
 * Session variable resolution: string values starting with `x-hasura-` (case-insensitive)
 * are resolved from `session.claims` at query time.
 */

import type {
  BoolExp,
  ColumnOperators,
  CompiledFilter,
  ComputedFieldConfig,
  ExistsExp,
  RelationshipConfig,
  SessionVariables,
} from '../types.js';
import { quoteIdentifier as quoteIdent } from '../sql/utils.js';
import { resolveSessionValue } from '../shared/session-resolution.js';

// ─── SQL operator mapping ──────────────────────────────────────────────────

interface SqlOperator {
  /** The SQL operator or keyword (e.g., '=', 'LIKE', '@>'). */
  sql: string;
  /** If true, the operator is negated (e.g., NOT LIKE). */
  negated?: boolean;
  /** Special handling mode. */
  mode?: 'is_null' | 'in' | 'jsonb_keys' | 'jsonb_keys_array';
}

const OPERATOR_MAP: Record<string, SqlOperator> = {
  // Comparison
  _eq:  { sql: '=' },
  _neq: { sql: '<>' },
  _ne:  { sql: '<>' },            // YAML metadata compat alias
  _gt:  { sql: '>' },
  _lt:  { sql: '<' },
  _gte: { sql: '>=' },
  _lte: { sql: '<=' },

  // List
  _in:  { sql: 'IN', mode: 'in' },
  _nin: { sql: 'NOT IN', mode: 'in' },

  // Null
  _isNull:  { sql: 'IS NULL', mode: 'is_null' },
  _is_null: { sql: 'IS NULL', mode: 'is_null' },  // YAML metadata compat alias

  // Text pattern matching
  _like:     { sql: 'LIKE' },
  _nlike:    { sql: 'NOT LIKE' },
  _ilike:    { sql: 'ILIKE' },
  _nilike:   { sql: 'NOT ILIKE' },
  _similar:  { sql: 'SIMILAR TO' },
  _nsimilar: { sql: 'NOT SIMILAR TO' },

  // Regex
  _regex:  { sql: '~' },
  _nregex: { sql: '!~' },
  _iregex: { sql: '~*' },
  _niregex:{ sql: '!~*' },

  // JSONB containment
  _contains:      { sql: '@>' },
  _containedIn:   { sql: '<@' },
  _contained_in:  { sql: '<@' },    // YAML metadata compat alias

  // JSONB key checks
  _hasKey:        { sql: '?', mode: 'jsonb_keys' },
  _has_key:       { sql: '?', mode: 'jsonb_keys' },        // YAML metadata compat alias
  _hasKeysAny:    { sql: '?|', mode: 'jsonb_keys_array' },
  _has_keys_any:  { sql: '?|', mode: 'jsonb_keys_array' }, // YAML metadata compat alias
  _hasKeysAll:    { sql: '?&', mode: 'jsonb_keys_array' },
  _has_keys_all:  { sql: '?&', mode: 'jsonb_keys_array' }, // YAML metadata compat alias
};

// Operators that are defined on ColumnOperators (as opposed to logical / _exists / column traversal).
const COLUMN_OPERATOR_KEYS = new Set(Object.keys(OPERATOR_MAP));

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Check whether a value is a session variable reference (x-hasura-*).
 */
function isSessionVariable(value: unknown): value is string {
  return typeof value === 'string' && value.toLowerCase().startsWith('x-hasura-');
}

/**
 * Resolve a value: if it is a session variable reference, look it up in the session claims.
 * Otherwise return the value as-is.
 *
 * Delegates core lookup to resolveSessionValue, then applies permission-specific
 * post-processing: null fallback for missing claims, single-element array unwrap.
 */
function resolveValue(value: unknown, session: SessionVariables): unknown {
  if (!isSessionVariable(value)) return value;

  const resolved = resolveSessionValue(value, session);
  if (resolved === undefined) {
    return null;
  }
  // If the claim is an array but a single value is expected, return the first element.
  if (Array.isArray(resolved) && resolved.length === 1) {
    return resolved[0];
  }
  return resolved;
}

/**
 * Qualify a column name, optionally prepending a table alias.
 */
function qualifyColumn(column: string, tableAlias?: string): string {
  if (tableAlias) {
    return `${quoteIdent(tableAlias)}.${quoteIdent(column)}`;
  }
  return quoteIdent(column);
}

// ─── Internal AST types ────────────────────────────────────────────────────

/**
 * Internal representation of a compiled filter node.
 * Each node knows how to produce SQL when given a session and parameter offset.
 */
interface FilterNode {
  toSQL(session: SessionVariables, paramOffset: number, tableAlias?: string): {
    sql: string;
    params: unknown[];
  };
}

// ─── Filter node constructors ──────────────────────────────────────────────

/**
 * A filter that always passes (empty filter / no restriction).
 */
const TRUE_FILTER: FilterNode = {
  toSQL() {
    return { sql: 'TRUE', params: [] };
  },
};

/**
 * Logical AND of multiple filter nodes.
 */
function andNode(children: FilterNode[]): FilterNode {
  if (children.length === 0) return TRUE_FILTER;
  if (children.length === 1) return children[0];

  return {
    toSQL(session, paramOffset, tableAlias) {
      const parts: string[] = [];
      const allParams: unknown[] = [];

      for (const child of children) {
        const result = child.toSQL(session, paramOffset + allParams.length, tableAlias);
        parts.push(result.sql);
        allParams.push(...result.params);
      }

      return {
        sql: `(${parts.join(' AND ')})`,
        params: allParams,
      };
    },
  };
}

/**
 * Logical OR of multiple filter nodes.
 */
function orNode(children: FilterNode[]): FilterNode {
  if (children.length === 0) return TRUE_FILTER;
  if (children.length === 1) return children[0];

  return {
    toSQL(session, paramOffset, tableAlias) {
      const parts: string[] = [];
      const allParams: unknown[] = [];

      for (const child of children) {
        const result = child.toSQL(session, paramOffset + allParams.length, tableAlias);
        parts.push(result.sql);
        allParams.push(...result.params);
      }

      return {
        sql: `(${parts.join(' OR ')})`,
        params: allParams,
      };
    },
  };
}

/**
 * Logical NOT of a filter node.
 */
function notNode(child: FilterNode): FilterNode {
  return {
    toSQL(session, paramOffset, tableAlias) {
      const result = child.toSQL(session, paramOffset, tableAlias);
      return {
        sql: `NOT (${result.sql})`,
        params: result.params,
      };
    },
  };
}

/**
 * EXISTS subquery node.
 */
function existsNode(tableName: string, tableSchema: string, whereNode: FilterNode): FilterNode {
  return {
    toSQL(session, paramOffset, _tableAlias) {
      const qualifiedTable = `${quoteIdent(tableSchema)}.${quoteIdent(tableName)}`;
      const result = whereNode.toSQL(session, paramOffset);
      return {
        sql: `EXISTS (SELECT 1 FROM ${qualifiedTable} WHERE ${result.sql})`,
        params: result.params,
      };
    },
  };
}

/** Counter for relationship subquery aliases within a single compilation. */
let relAliasCounter = 0;

/**
 * Relationship EXISTS subquery node.
 *
 * Compiles `{ relName: { remote_col: { _eq: ... } } }` into:
 *   EXISTS (SELECT 1 FROM "schema"."remote_table" AS "_rel_0"
 *     WHERE "_rel_0"."remote_col" = "tableAlias"."local_col"
 *     AND <nested filter on _rel_0>)
 */
function relationshipExistsNode(
  rel: RelationshipConfig,
  nestedNode: FilterNode,
): FilterNode {
  return {
    toSQL(session, paramOffset, tableAlias) {
      const subAlias = `_rel_${relAliasCounter++}`;
      const qualifiedTable = `${quoteIdent(rel.remoteTable.schema)}.${quoteIdent(rel.remoteTable.name)}`;

      // Build join conditions from the relationship's column mapping
      const joinConds: string[] = [];
      if (rel.columnMapping) {
        for (const [localCol, remoteCol] of Object.entries(rel.columnMapping)) {
          const localRef = tableAlias
            ? `${quoteIdent(tableAlias)}.${quoteIdent(localCol)}`
            : quoteIdent(localCol);
          joinConds.push(`${quoteIdent(subAlias)}.${quoteIdent(remoteCol)} = ${localRef}`);
        }
      } else if (rel.localColumns && rel.remoteColumns) {
        for (let i = 0; i < rel.localColumns.length; i++) {
          const localRef = tableAlias
            ? `${quoteIdent(tableAlias)}.${quoteIdent(rel.localColumns[i])}`
            : quoteIdent(rel.localColumns[i]);
          joinConds.push(`${quoteIdent(subAlias)}.${quoteIdent(rel.remoteColumns[i])} = ${localRef}`);
        }
      }

      // Compile the nested filter scoped to the subquery alias
      const nested = nestedNode.toSQL(session, paramOffset, subAlias);

      const allConds = [...joinConds];
      if (nested.sql && nested.sql !== 'TRUE') {
        allConds.push(nested.sql);
      }

      const whereClause = allConds.length > 0 ? allConds.join(' AND ') : 'TRUE';
      return {
        sql: `EXISTS (SELECT 1 FROM ${qualifiedTable} ${quoteIdent(subAlias)} WHERE ${whereClause})`,
        params: nested.params,
      };
    },
  };
}

/**
 * Build a SQL reference for a computed field: "schema"."fn_name"("alias").
 */
function computedFieldRef(cf: ComputedFieldConfig, tableAlias?: string): string {
  const fnSchema = cf.function.schema ?? 'public';
  const funcRef = `${quoteIdent(fnSchema)}.${quoteIdent(cf.function.name)}`;
  if (tableAlias) {
    return `${funcRef}(${quoteIdent(tableAlias)})`;
  }
  return `${funcRef}(*)`;
}

/**
 * A single column comparison node.
 * If `computedField` is provided, the column reference is replaced with a function call.
 */
function comparisonNode(
  column: string,
  operatorKey: string,
  rawValue: unknown,
  computedField?: ComputedFieldConfig,
): FilterNode {
  const op = OPERATOR_MAP[operatorKey];
  if (!op) {
    throw new Error(`Unknown operator: ${operatorKey}`);
  }

  return {
    toSQL(session, paramOffset, tableAlias) {
      const col = computedField
        ? computedFieldRef(computedField, tableAlias)
        : qualifyColumn(column, tableAlias);

      // ── IS NULL / IS NOT NULL ────────────────────────────────────────
      if (op.mode === 'is_null') {
        const isNull = Boolean(rawValue);
        return {
          sql: isNull ? `${col} IS NULL` : `${col} IS NOT NULL`,
          params: [],
        };
      }

      // ── IN / NOT IN ─────────────────────────────────────────────────
      if (op.mode === 'in') {
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        const resolvedValues = values.map(v => resolveValue(v, session));
        // Flatten any session variable arrays into individual values.
        const flatValues: unknown[] = [];
        for (const v of resolvedValues) {
          if (Array.isArray(v)) {
            flatValues.push(...v);
          } else {
            flatValues.push(v);
          }
        }

        if (flatValues.length === 0) {
          // IN with empty list: always false / NOT IN with empty list: always true
          return {
            sql: op.sql === 'IN' ? 'FALSE' : 'TRUE',
            params: [],
          };
        }

        const placeholders = flatValues.map(
          (_, i) => `$${paramOffset + i + 1}`,
        );
        return {
          sql: `${col} ${op.sql} (${placeholders.join(', ')})`,
          params: flatValues,
        };
      }

      // ── JSONB key array operators (?| and ?&) ───────────────────────
      if (op.mode === 'jsonb_keys_array') {
        const keys = Array.isArray(rawValue) ? rawValue : [rawValue];
        const resolvedKeys = keys.map(k => resolveValue(k, session));
        const placeholder = `$${paramOffset + 1}`;
        return {
          sql: `${col} ${op.sql} ${placeholder}`,
          params: [resolvedKeys],
        };
      }

      // ── JSONB single key operator (?) ───────────────────────────────
      if (op.mode === 'jsonb_keys') {
        const resolved = resolveValue(rawValue, session);
        const placeholder = `$${paramOffset + 1}`;
        return {
          sql: `${col} ${op.sql} ${placeholder}`,
          params: [resolved],
        };
      }

      // ── Standard comparison / pattern operators ─────────────────────
      const resolved = resolveValue(rawValue, session);
      const placeholder = `$${paramOffset + 1}`;

      // JSONB containment operators: serialize objects to JSON
      if (operatorKey === '_contains' || operatorKey === '_contained_in' || operatorKey === '_containedIn') {
        const jsonValue = typeof resolved === 'object' ? JSON.stringify(resolved) : resolved;
        return {
          sql: `${col} ${op.sql} ${placeholder}`,
          params: [jsonValue],
        };
      }

      return {
        sql: `${col} ${op.sql} ${placeholder}`,
        params: [resolved],
      };
    },
  };
}

// ─── BoolExp parser ────────────────────────────────────────────────────────

/**
 * Check if a value looks like a ColumnOperators object
 * (i.e., has at least one key that is a known column operator).
 */
function isColumnOperators(value: unknown): value is ColumnOperators {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).some(k => COLUMN_OPERATOR_KEYS.has(k));
}

/**
 * Parse a BoolExp into a FilterNode tree.
 *
 * This is called once at startup; the resulting tree is then evaluated
 * with different sessions at query time.
 *
 * @param computedFieldMap - Optional map of computed field name → config,
 *   so that BoolExp keys referencing computed fields emit function calls
 *   instead of column references.
 * @param relationshipMap - Optional map of relationship name → config,
 *   so that BoolExp keys referencing relationships emit EXISTS subqueries.
 */
function parseBoolExp(
  filter: BoolExp,
  computedFieldMap?: Map<string, ComputedFieldConfig>,
  relationshipMap?: Map<string, RelationshipConfig>,
): FilterNode {
  // Empty object = no restriction
  const keys = Object.keys(filter);
  if (keys.length === 0) {
    return TRUE_FILTER;
  }

  // ── Logical operators ─────────────────────────────────────────────────
  if ('_and' in filter) {
    const children = (filter as { _and: BoolExp[] })._and.map(
      (sub) => parseBoolExp(sub, computedFieldMap, relationshipMap),
    );
    return andNode(children);
  }

  if ('_or' in filter) {
    const children = (filter as { _or: BoolExp[] })._or.map(
      (sub) => parseBoolExp(sub, computedFieldMap, relationshipMap),
    );
    return orNode(children);
  }

  if ('_not' in filter) {
    const child = parseBoolExp((filter as { _not: BoolExp })._not, computedFieldMap, relationshipMap);
    return notNode(child);
  }

  // ── _exists ───────────────────────────────────────────────────────────
  if ('_exists' in filter) {
    const existsExp = (filter as { _exists: ExistsExp })._exists;
    const whereNode = parseBoolExp(existsExp._where);
    return existsNode(existsExp._table.name, existsExp._table.schema, whereNode);
  }

  // ── Column filters ────────────────────────────────────────────────────
  // Each top-level key is a column name, value is either ColumnOperators or a nested BoolExp
  // for relationship traversal. Multiple keys are implicitly ANDed.
  const children: FilterNode[] = [];

  for (const [column, ops] of Object.entries(filter)) {
    if (isColumnOperators(ops)) {
      // Check if this key refers to a computed field
      const cf = computedFieldMap?.get(column);
      // Column with one or more comparison operators
      for (const [opKey, opValue] of Object.entries(ops as Record<string, unknown>)) {
        if (COLUMN_OPERATOR_KEYS.has(opKey) && opValue !== undefined) {
          children.push(comparisonNode(column, opKey, opValue, cf));
        }
      }
    } else {
      // Nested BoolExp for relationship traversal
      const rel = relationshipMap?.get(column);
      if (rel) {
        // Compile as EXISTS subquery with proper join conditions
        const nestedFilter = parseBoolExp(ops as BoolExp);
        children.push(relationshipExistsNode(rel, nestedFilter));
      } else {
        // No relationship info — fall back to nested column filter on same table
        const nestedFilter = parseBoolExp(ops as BoolExp);
        children.push({
          toSQL(session, paramOffset, _tableAlias) {
            return nestedFilter.toSQL(session, paramOffset, column);
          },
        });
      }
    }
  }

  return andNode(children);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Compile a BoolExp permission filter into a CompiledFilter.
 *
 * The compiled filter can be evaluated multiple times with different sessions,
 * always producing parameterized SQL.
 *
 * @param computedFields - Optional array of computed field configs for the table.
 *   When a BoolExp key matches a computed field name, the compiler emits a
 *   function call (e.g. `"public"."fn"("t0")`) instead of a column reference.
 *
 * @example
 * ```ts
 * const filter = compileFilter({ user_id: { _eq: 'X-Hasura-User-Id' } });
 * const { sql, params } = filter.toSQL(session, 0);
 * // sql:    '"user_id" = $1'
 * // params: ['42']
 * ```
 */
export function compileFilter(
  filter: BoolExp,
  computedFields?: ComputedFieldConfig[],
  relationships?: RelationshipConfig[],
): CompiledFilter {
  const cfMap = computedFields && computedFields.length > 0
    ? new Map(computedFields.map((cf) => [cf.name, cf]))
    : undefined;
  const relMap = relationships && relationships.length > 0
    ? new Map(relationships.map((r) => [r.name, r]))
    : undefined;
  relAliasCounter = 0;
  const node = parseBoolExp(filter, cfMap, relMap);
  return {
    toSQL(session: SessionVariables, paramOffset: number, tableAlias?: string) {
      return node.toSQL(session, paramOffset, tableAlias);
    },
  };
}
