/**
 * PostgREST-style query string filter parser.
 *
 * Parses filter syntax like `column=op.value` and converts to BoolExp format
 * compatible with the internal SQL compiler.
 */

import type { BoolExp, ColumnOperators } from '../types.js';

// ─── Parsed query result ─────────────────────────────────────────────────────

export interface ParsedRESTQuery {
  where: BoolExp;
  orderBy: OrderByClause[];
  limit?: number;
  offset?: number;
  select?: string[];
  distinctOn?: string[];
}

export interface OrderByClause {
  column: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

// ─── Operator parsing ────────────────────────────────────────────────────────

/**
 * Mapping from PostgREST operator names to BoolExp operator keys.
 */
const SIMPLE_OPERATORS: Record<string, keyof ColumnOperators> = {
  eq: '_eq',
  neq: '_ne',
  gt: '_gt',
  gte: '_gte',
  lt: '_lt',
  lte: '_lte',
  like: '_like',
  ilike: '_ilike',
};

/**
 * Try to coerce a string value to its appropriate JS type.
 * Numeric strings become numbers, "true"/"false" become booleans.
 */
function coerceValue(raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Try parsing as number if it looks numeric
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      return num;
    }
  }

  return raw;
}

/**
 * Parse a single filter value string of the form `op.value` or `op.(values)`.
 *
 * Examples:
 * - `eq.hello`         → { _eq: "hello" }
 * - `neq.42`           → { _ne: 42 }
 * - `in.(a,b,c)`       → { _in: ["a", "b", "c"] }
 * - `is.null`          → { _is_null: true }
 * - `is.true`          → { _eq: true }
 * - `like.*pattern*`   → { _like: "*pattern*" }
 */
function parseFilterValue(filterStr: string): ColumnOperators | null {
  // Find the first dot to split operator from value
  const dotIndex = filterStr.indexOf('.');
  if (dotIndex === -1) return null;

  const operator = filterStr.slice(0, dotIndex);
  const rawValue = filterStr.slice(dotIndex + 1);

  // Handle `in.(a,b,c)` operator
  if (operator === 'in' || operator === 'nin') {
    const inner = rawValue.replace(/^\(/, '').replace(/\)$/, '');
    const values = inner.split(',').map((v) => coerceValue(v.trim()));
    const key = operator === 'in' ? '_in' : '_nin';
    return { [key]: values } as ColumnOperators;
  }

  // Handle `is.null`, `is.true`, `is.false`
  if (operator === 'is') {
    const lowerVal = rawValue.toLowerCase();
    if (lowerVal === 'null') {
      return { _is_null: true };
    }
    if (lowerVal === 'true') {
      return { _eq: true };
    }
    if (lowerVal === 'false') {
      return { _eq: false };
    }
    return null;
  }

  // Handle `not` prefix: `not.eq.value`, `not.in.(a,b)`
  if (operator === 'not') {
    const inner = parseFilterValue(rawValue);
    if (!inner) return null;
    // Negate by wrapping — for common cases we can map directly
    if ('_eq' in inner) return { _ne: inner._eq } as ColumnOperators;
    if ('_ne' in inner) return { _eq: inner._ne } as ColumnOperators;
    if ('_in' in inner) return { _nin: inner._in } as ColumnOperators;
    if ('_like' in inner) return { _nlike: inner._like } as ColumnOperators;
    if ('_ilike' in inner) return { _nilike: inner._ilike } as ColumnOperators;
    if ('_is_null' in inner) return { _is_null: !inner._is_null } as ColumnOperators;
    return inner;
  }

  // Simple operators: eq, neq, gt, gte, lt, lte, like, ilike
  const opKey = SIMPLE_OPERATORS[operator];
  if (opKey) {
    return { [opKey]: coerceValue(rawValue) } as ColumnOperators;
  }

  return null;
}

// ─── Order parsing ───────────────────────────────────────────────────────────

/**
 * Parse an `order` query parameter.
 *
 * Formats:
 * - `column.asc`
 * - `column.desc`
 * - `col1.asc,col2.desc`
 * - `column.asc.nullsfirst`
 * - `column.desc.nullslast`
 */
function parseOrder(orderStr: string): OrderByClause[] {
  const clauses: OrderByClause[] = [];

  for (const segment of orderStr.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('.');
    const column = parts[0];
    const direction = (parts[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc';

    let nulls: 'first' | 'last' | undefined;
    if (parts[2]) {
      const nullsPart = parts[2].toLowerCase();
      if (nullsPart === 'nullsfirst') nulls = 'first';
      else if (nullsPart === 'nullslast') nulls = 'last';
    }

    clauses.push({ column, direction, nulls });
  }

  return clauses;
}

// ─── Select parsing ─────────────────────────────────────────────────────────

/**
 * Parse a `select` query parameter.
 *
 * Format: `col1,col2,col3`
 */
function parseSelect(selectStr: string): string[] {
  return selectStr.split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Main parser ─────────────────────────────────────────────────────────────

/** Reserved query parameter names that are not column filters. */
const RESERVED_PARAMS = new Set(['order', 'limit', 'offset', 'select', 'distinct_on']);

/**
 * Parse query string parameters into a structured REST query.
 *
 * Handles PostgREST-style filter syntax where:
 * - `column=op.value` applies a filter on the column
 * - `order=column.asc` sets ordering
 * - `limit=N` sets row limit
 * - `offset=N` sets offset for pagination
 * - `select=col1,col2` selects specific columns
 *
 * @param query - The query string parameters as key-value pairs.
 * @returns A parsed REST query with where clause, ordering, limit, offset, and selected columns.
 */
export function parseRESTFilters(query: Record<string, string>): ParsedRESTQuery {
  const columnFilters: Record<string, ColumnOperators> = {};
  let orderBy: OrderByClause[] = [];
  let limit: number | undefined;
  let offset: number | undefined;
  let select: string[] | undefined;
  let distinctOn: string[] | undefined;

  for (const [key, value] of Object.entries(query)) {
    if (!value && value !== '') continue;

    // Handle reserved parameters
    if (key === 'order') {
      orderBy = parseOrder(value);
      continue;
    }

    if (key === 'limit') {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        limit = parsed;
      }
      continue;
    }

    if (key === 'offset') {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        offset = parsed;
      }
      continue;
    }

    if (key === 'select') {
      select = parseSelect(value);
      continue;
    }

    if (key === 'distinct_on') {
      distinctOn = value.split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }

    // Column filter: key is column name, value is `op.value`
    const ops = parseFilterValue(value);
    if (ops) {
      // Merge operators for the same column (multiple filters on one column)
      if (columnFilters[key]) {
        Object.assign(columnFilters[key], ops);
      } else {
        columnFilters[key] = ops;
      }
    }
  }

  // Build BoolExp from column filters
  const where = buildWhere(columnFilters);

  return { where, orderBy, limit, offset, select, distinctOn };
}

/**
 * Build a BoolExp from parsed column filters.
 */
function buildWhere(columnFilters: Record<string, ColumnOperators>): BoolExp {
  const entries = Object.entries(columnFilters);
  if (entries.length === 0) {
    return {} as BoolExp;
  }

  // Each column filter becomes a key in the BoolExp
  const boolExp: Record<string, ColumnOperators> = {};
  for (const [column, ops] of entries) {
    boolExp[column] = ops;
  }

  return boolExp as unknown as BoolExp;
}
