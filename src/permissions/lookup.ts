/**
 * Permission lookup table.
 *
 * Pre-compiles all table permissions at startup into an efficient lookup
 * map keyed by `${schema}.${table}:${role}:${operation}`.
 *
 * Admin role returns a special "allow-all" permission.
 * Missing permissions = deny (returns null).
 */

import type {
  CompiledFilter,
  CompiledPermission,
  Operation,
  SessionVariables,
  TableInfo,
} from '../types.js';
import { compileFilter } from './compiler.js';

// ─── Allow-all filter (always TRUE) ────────────────────────────────────────

const ALLOW_ALL_FILTER: CompiledFilter = {
  toSQL(_session: SessionVariables, _paramOffset: number, _tableAlias?: string) {
    return { sql: 'TRUE', params: [] };
  },
};

// ─── Admin "allow everything" permission ───────────────────────────────────

const ADMIN_PERMISSION: CompiledPermission = {
  select: {
    filter: ALLOW_ALL_FILTER,
    columns: '*',
    allowAggregations: true,
  },
  insert: {
    check: ALLOW_ALL_FILTER,
    columns: '*',
    presets: {},
  },
  update: {
    filter: ALLOW_ALL_FILTER,
    columns: '*',
    presets: {},
  },
  delete: {
    filter: ALLOW_ALL_FILTER,
  },
};

// ─── Lookup key construction ───────────────────────────────────────────────

function lookupKey(schema: string, table: string, role: string, operation: Operation): string {
  return `${schema}.${table}:${role}:${operation}`;
}

// ─── Permission lookup interface ───────────────────────────────────────────

export interface PermissionLookup {
  /**
   * Look up the compiled permission for a specific table, role, and operation.
   *
   * Returns `null` if the role does not have the requested permission (deny).
   * The admin role always returns the allow-all permission.
   */
  get(table: string, schema: string, role: string, operation: Operation): CompiledPermission | null;
}

// ─── Permission compilation ────────────────────────────────────────────────

/**
 * Compile select permissions for a single role on a single table.
 */
function compileSelectPermission(
  perm: NonNullable<TableInfo['permissions']['select'][string]>,
): NonNullable<CompiledPermission['select']> {
  return {
    filter: compileFilter(perm.filter),
    columns: perm.columns,
    limit: perm.limit,
    allowAggregations: perm.allowAggregations ?? false,
  };
}

/**
 * Compile insert permissions for a single role on a single table.
 */
function compileInsertPermission(
  perm: NonNullable<TableInfo['permissions']['insert'][string]>,
): NonNullable<CompiledPermission['insert']> {
  return {
    check: compileFilter(perm.check),
    columns: perm.columns,
    presets: perm.set ?? {},
  };
}

/**
 * Compile update permissions for a single role on a single table.
 */
function compileUpdatePermission(
  perm: NonNullable<TableInfo['permissions']['update'][string]>,
): NonNullable<CompiledPermission['update']> {
  return {
    filter: compileFilter(perm.filter),
    check: perm.check ? compileFilter(perm.check) : undefined,
    columns: perm.columns,
    presets: perm.set ?? {},
  };
}

/**
 * Compile delete permissions for a single role on a single table.
 */
function compileDeletePermission(
  perm: NonNullable<TableInfo['permissions']['delete'][string]>,
): NonNullable<CompiledPermission['delete']> {
  return {
    filter: compileFilter(perm.filter),
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Build a permission lookup from the table definitions.
 *
 * Pre-compiles all permission filters at startup so that query-time
 * permission checks are as fast as possible (just a Map lookup + SQL generation).
 *
 * @example
 * ```ts
 * const lookup = buildPermissionLookup(tables);
 * const perm = lookup.get('users', 'public', 'user', 'select');
 * if (perm?.select) {
 *   const { sql, params } = perm.select.filter.toSQL(session, 0);
 * }
 * ```
 */
export function buildPermissionLookup(tables: TableInfo[]): PermissionLookup {
  const map = new Map<string, CompiledPermission>();

  for (const table of tables) {
    const { permissions } = table;

    // Collect all roles that appear across any operation for this table.
    const roleSet = new Set<string>();
    for (const role of Object.keys(permissions.select)) roleSet.add(role);
    for (const role of Object.keys(permissions.insert)) roleSet.add(role);
    for (const role of Object.keys(permissions.update)) roleSet.add(role);
    for (const role of Object.keys(permissions.delete)) roleSet.add(role);

    for (const role of roleSet) {
      const compiled: CompiledPermission = {};

      const selectPerm = permissions.select[role];
      if (selectPerm) {
        compiled.select = compileSelectPermission(selectPerm);
      }

      const insertPerm = permissions.insert[role];
      if (insertPerm) {
        compiled.insert = compileInsertPermission(insertPerm);
      }

      const updatePerm = permissions.update[role];
      if (updatePerm) {
        compiled.update = compileUpdatePermission(updatePerm);
      }

      const deletePerm = permissions.delete[role];
      if (deletePerm) {
        compiled.delete = compileDeletePermission(deletePerm);
      }

      // Store the compiled permission under each operation key for O(1) lookup.
      // Only store if the role actually has that permission defined.
      if (compiled.select) {
        map.set(lookupKey(table.schema, table.name, role, 'select'), compiled);
      }
      if (compiled.insert) {
        map.set(lookupKey(table.schema, table.name, role, 'insert'), compiled);
      }
      if (compiled.update) {
        map.set(lookupKey(table.schema, table.name, role, 'update'), compiled);
      }
      if (compiled.delete) {
        map.set(lookupKey(table.schema, table.name, role, 'delete'), compiled);
      }
    }
  }

  return {
    get(table: string, schema: string, role: string, operation: Operation): CompiledPermission | null {
      // Admin role always gets full access.
      if (role === 'admin') {
        return ADMIN_PERMISSION;
      }

      const key = lookupKey(schema, table, role, operation);
      return map.get(key) ?? null;
    },
  };
}
