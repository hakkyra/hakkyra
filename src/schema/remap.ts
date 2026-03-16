/**
 * Shared remapping utilities for camelCase <-> snake_case conversion
 * in GraphQL arguments (BoolExp, column maps, limits).
 *
 * Extracted from resolvers/helpers.ts so that modules like tracked-functions.ts
 * and subscription-resolvers.ts can use them without importing from the
 * resolver barrel (which creates tight coupling).
 */

import type {
  TableInfo,
  BoolExp,
} from '../types.js';
import { getColumnFieldName, getRelFieldName } from './type-builder.js';

// ---- camelCase <-> snake_case column map ----

/**
 * Build a mapping of camelCase field names -> snake_case column names for a table.
 */
export function camelToColumnMap(table: TableInfo): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of table.columns) {
    map.set(getColumnFieldName(table, col.name), col.name);
  }
  return map;
}

// ---- BoolExp remapping ----

/**
 * Recursively remap camelCase keys in a BoolExp to snake_case column names.
 * Logical operators (_and, _or, _not) and comparison operators (_eq, _gt, etc.)
 * are preserved as-is; only column-level keys are remapped.
 *
 * When `table` and `allTables` are provided, aggregate filter keys (e.g., `accountsAggregate`)
 * are detected and converted into internal `_aggregateFilter` entries for the SQL compiler.
 */
export function remapBoolExp(
  boolExp: BoolExp | undefined | null,
  columnMap: Map<string, string>,
  table?: TableInfo,
  allTables?: TableInfo[],
): BoolExp | undefined {
  if (!boolExp || typeof boolExp !== 'object') return undefined;

  const keys = Object.keys(boolExp);
  if (keys.length === 0) return boolExp;

  // _and: recursively remap each child
  if ('_and' in boolExp) {
    const typed = boolExp as { _and: BoolExp[] };
    return { _and: typed._and.map((sub) => remapBoolExp(sub, columnMap, table, allTables) ?? ({} as BoolExp)) };
  }

  // _or: recursively remap each child
  if ('_or' in boolExp) {
    const typed = boolExp as { _or: BoolExp[] };
    return { _or: typed._or.map((sub) => remapBoolExp(sub, columnMap, table, allTables) ?? ({} as BoolExp)) };
  }

  // _not: recursively remap child
  if ('_not' in boolExp) {
    const typed = boolExp as { _not: BoolExp };
    return { _not: remapBoolExp(typed._not, columnMap, table, allTables) ?? ({} as BoolExp) };
  }

  // _exists: pass through (table-level, not column-level)
  if ('_exists' in boolExp) {
    return boolExp;
  }

  // Build a map of aggregate filter key -> relationship config for quick lookup
  const aggRelMap = new Map<string, TableInfo['relationships'][number]>();
  if (table && allTables) {
    for (const rel of table.relationships) {
      if (rel.type === 'array') {
        aggRelMap.set(`${getRelFieldName(rel)}Aggregate`, rel);
      }
    }
  }

  // Build a map of relationship name -> relationship config for traversal filters
  const relMap = new Map<string, TableInfo['relationships'][number]>();
  if (table) {
    for (const rel of table.relationships) {
      relMap.set(getRelFieldName(rel), rel);
    }
  }

  // Column-level: remap keys from camelCase to snake_case
  const result: Record<string, unknown> = {};
  const aggregateFilters: unknown[] = [];

  for (const [key, value] of Object.entries(boolExp as Record<string, unknown>)) {
    // Check for aggregate filter keys (e.g., accountsAggregate)
    const aggRel = aggRelMap.get(key);
    if (aggRel && value && typeof value === 'object') {
      const aggValue = value as Record<string, unknown>;

      // Currently only 'count' is supported
      if (aggValue.count && typeof aggValue.count === 'object') {
        const countSpec = aggValue.count as Record<string, unknown>;
        const remoteTable = allTables!.find(
          (t) => t.name === aggRel.remoteTable.name && t.schema === aggRel.remoteTable.schema,
        );
        if (!remoteTable) continue;

        // Build column mapping from the relationship config
        const colMapping: Record<string, string> = {};
        if (aggRel.columnMapping) {
          for (const [localCol, remoteCol] of Object.entries(aggRel.columnMapping)) {
            colMapping[localCol] = remoteCol;
          }
        } else if (aggRel.localColumns && aggRel.remoteColumns) {
          for (let i = 0; i < aggRel.localColumns.length; i++) {
            colMapping[aggRel.localColumns[i]] = aggRel.remoteColumns[i];
          }
        }

        // Remap the filter sub-expression if present
        let remappedFilter: BoolExp | undefined;
        if (countSpec.filter) {
          const remoteColMap = camelToColumnMap(remoteTable);
          remappedFilter = remapBoolExp(
            countSpec.filter as BoolExp,
            remoteColMap,
            remoteTable,
            allTables,
          );
        }

        aggregateFilters.push({
          _aggregateFilter: {
            function: 'count',
            arguments: countSpec.arguments as string[] | undefined,
            distinct: countSpec.distinct as boolean | undefined,
            filter: remappedFilter,
            predicate: countSpec.predicate,
            columnMapping: colMapping,
            remoteSchema: remoteTable.schema,
            remoteTable: remoteTable.name,
          },
        });
      }
      continue;
    }

    // Check for relationship traversal filter keys (e.g., campaign: { key: { _eq: "foo" } })
    const rel = relMap.get(key);
    if (rel && value && typeof value === 'object' && allTables) {
      const remoteTable = allTables.find(
        (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
      );
      if (remoteTable) {
        // Build column mapping from the relationship config
        const colMapping: Record<string, string> = {};
        if (rel.columnMapping) {
          for (const [localCol, remoteCol] of Object.entries(rel.columnMapping)) {
            colMapping[localCol] = remoteCol;
          }
        } else if (rel.localColumns && rel.remoteColumns) {
          for (let i = 0; i < rel.localColumns.length; i++) {
            colMapping[rel.localColumns[i]] = rel.remoteColumns[i];
          }
        }

        // Recursively remap the child BoolExp using remote table's column map
        const remoteColMap = camelToColumnMap(remoteTable);
        const remappedChild = remapBoolExp(
          value as BoolExp,
          remoteColMap,
          remoteTable,
          allTables,
        );

        aggregateFilters.push({
          _relationshipFilter: {
            columnMapping: colMapping,
            remoteSchema: remoteTable.schema,
            remoteTable: remoteTable.name,
            where: remappedChild,
          },
        });
        continue;
      }
    }

    const pgName = columnMap.get(key) ?? key;
    result[pgName] = value;
  }

  // If we have aggregate/relationship filters, combine them with regular filters using _and
  if (aggregateFilters.length > 0) {
    const parts: BoolExp[] = [];
    if (Object.keys(result).length > 0) {
      parts.push(result as BoolExp);
    }
    for (const af of aggregateFilters) {
      parts.push(af as BoolExp);
    }
    if (parts.length === 1) return parts[0];
    return { _and: parts };
  }

  return result as BoolExp;
}

// ---- Limit resolution ----

/**
 * Resolve the most restrictive limit among user-provided, permission-defined, and global max.
 */
export function resolveLimit(userLimit?: number, permLimit?: number, globalMaxLimit?: number): number | undefined {
  let limit: number | undefined;
  if (userLimit !== undefined && permLimit !== undefined) {
    limit = Math.min(userLimit, permLimit);
  } else {
    limit = userLimit ?? permLimit;
  }
  if (globalMaxLimit !== undefined && globalMaxLimit > 0) {
    if (limit !== undefined) {
      limit = Math.min(limit, globalMaxLimit);
    } else {
      limit = globalMaxLimit;
    }
  }
  return limit;
}
