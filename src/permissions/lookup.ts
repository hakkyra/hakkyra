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
  ComputedFieldConfig,
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
  computedFields?: ComputedFieldConfig[],
  relationships?: TableInfo['relationships'],
): NonNullable<CompiledPermission['select']> {
  return {
    filter: compileFilter(perm.filter, computedFields, relationships),
    columns: perm.columns,
    limit: perm.limit,
    allowAggregations: perm.allowAggregations ?? false,
    computedFields: perm.computedFields,
  };
}

/**
 * Compile insert permissions for a single role on a single table.
 */
function compileInsertPermission(
  perm: NonNullable<TableInfo['permissions']['insert'][string]>,
  computedFields?: ComputedFieldConfig[],
  relationships?: TableInfo['relationships'],
): NonNullable<CompiledPermission['insert']> {
  return {
    check: compileFilter(perm.check, computedFields, relationships),
    columns: perm.columns,
    presets: perm.set ?? {},
  };
}

/**
 * Compile update permissions for a single role on a single table.
 */
function compileUpdatePermission(
  perm: NonNullable<TableInfo['permissions']['update'][string]>,
  computedFields?: ComputedFieldConfig[],
  relationships?: TableInfo['relationships'],
): NonNullable<CompiledPermission['update']> {
  return {
    filter: compileFilter(perm.filter, computedFields, relationships),
    check: perm.check ? compileFilter(perm.check, computedFields, relationships) : undefined,
    columns: perm.columns,
    presets: perm.set ?? {},
  };
}

/**
 * Compile delete permissions for a single role on a single table.
 */
function compileDeletePermission(
  perm: NonNullable<TableInfo['permissions']['delete'][string]>,
  computedFields?: ComputedFieldConfig[],
  relationships?: TableInfo['relationships'],
): NonNullable<CompiledPermission['delete']> {
  return {
    filter: compileFilter(perm.filter, computedFields, relationships),
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

// ─── Inherited role merging helpers ────────────────────────────────────────

/**
 * Create a CompiledFilter that ORs together multiple constituent filters.
 * Hasura inherited roles use the most permissive (union) semantics.
 */
function orFilters(filters: CompiledFilter[]): CompiledFilter {
  if (filters.length === 1) return filters[0]!;
  return {
    toSQL(session: SessionVariables, paramOffset: number, tableAlias?: string) {
      const parts: string[] = [];
      const allParams: unknown[] = [];
      let offset = paramOffset;
      for (const f of filters) {
        const { sql, params } = f.toSQL(session, offset, tableAlias);
        parts.push(sql);
        allParams.push(...params);
        offset += params.length;
      }
      return { sql: `(${parts.join(' OR ')})`, params: allParams };
    },
  };
}

/**
 * Merge multiple select permissions using Hasura's inherited role semantics:
 * columns = union, filter = OR, allowAggregations = any, limit = max (none if any is unlimited).
 */
function mergeSelectPermissions(
  perms: NonNullable<CompiledPermission['select']>[],
): NonNullable<CompiledPermission['select']> {
  const filter = orFilters(perms.map((p) => p.filter));

  // Columns: union. If any role has '*', inherited role gets '*'.
  let columns: string[] | '*' = [];
  for (const p of perms) {
    if (p.columns === '*') {
      columns = '*';
      break;
    }
    for (const c of p.columns) {
      if (!columns.includes(c)) columns.push(c);
    }
  }

  // Limit: most permissive = highest limit, or no limit if any constituent has none.
  let limit: number | undefined;
  for (const p of perms) {
    if (p.limit === undefined) {
      limit = undefined;
      break;
    }
    limit = limit === undefined ? p.limit : Math.max(limit, p.limit);
  }

  // AllowAggregations: true if any constituent allows.
  const allowAggregations = perms.some((p) => p.allowAggregations);

  // ComputedFields: union.
  let computedFields: string[] | undefined;
  for (const p of perms) {
    if (p.computedFields) {
      if (!computedFields) computedFields = [];
      for (const cf of p.computedFields) {
        if (!computedFields.includes(cf)) computedFields.push(cf);
      }
    }
  }

  return { filter, columns, limit, allowAggregations, computedFields };
}

/**
 * Merge multiple insert permissions: columns = union, check = OR, presets = empty.
 */
function mergeInsertPermissions(
  perms: NonNullable<CompiledPermission['insert']>[],
): NonNullable<CompiledPermission['insert']> {
  const check = orFilters(perms.map((p) => p.check));
  let columns: string[] | '*' = [];
  for (const p of perms) {
    if (p.columns === '*') { columns = '*'; break; }
    for (const c of p.columns) {
      if (!columns.includes(c)) columns.push(c);
    }
  }
  return { check, columns, presets: {} };
}

/**
 * Merge multiple update permissions: columns = union, filter = OR, check = OR, presets = empty.
 */
function mergeUpdatePermissions(
  perms: NonNullable<CompiledPermission['update']>[],
): NonNullable<CompiledPermission['update']> {
  const filter = orFilters(perms.map((p) => p.filter));
  const checks = perms.map((p) => p.check).filter((c): c is CompiledFilter => c !== undefined);
  const check = checks.length > 0 ? orFilters(checks) : undefined;
  let columns: string[] | '*' = [];
  for (const p of perms) {
    if (p.columns === '*') { columns = '*'; break; }
    for (const c of p.columns) {
      if (!columns.includes(c)) columns.push(c);
    }
  }
  return { filter, check, columns, presets: {} };
}

/**
 * Merge multiple delete permissions: filter = OR.
 */
function mergeDeletePermissions(
  perms: NonNullable<CompiledPermission['delete']>[],
): NonNullable<CompiledPermission['delete']> {
  return { filter: orFilters(perms.map((p) => p.filter)) };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Build a permission lookup from the table definitions.
 *
 * Pre-compiles all permission filters at startup so that query-time
 * permission checks are as fast as possible (just a Map lookup + SQL generation).
 *
 * @param tables - All tracked tables with their permission definitions.
 * @param inheritedRoles - Mapping of inherited role names to their constituent role sets.
 *
 * @example
 * ```ts
 * const lookup = buildPermissionLookup(tables, { backoffice_admin: ['backoffice', 'admin'] });
 * const perm = lookup.get('users', 'public', 'backoffice_admin', 'select');
 * ```
 */
export function buildPermissionLookup(
  tables: TableInfo[],
  inheritedRoles: Record<string, string[]> = {},
): PermissionLookup {
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
        compiled.select = compileSelectPermission(selectPerm, table.computedFields, table.relationships);
      }

      const insertPerm = permissions.insert[role];
      if (insertPerm) {
        compiled.insert = compileInsertPermission(insertPerm, table.computedFields, table.relationships);
      }

      const updatePerm = permissions.update[role];
      if (updatePerm) {
        compiled.update = compileUpdatePermission(updatePerm, table.computedFields, table.relationships);
      }

      const deletePerm = permissions.delete[role];
      if (deletePerm) {
        compiled.delete = compileDeletePermission(deletePerm, table.computedFields, table.relationships);
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

    // ── Inherited roles: merge constituent role permissions ──────────
    for (const [inheritedRole, constituentRoles] of Object.entries(inheritedRoles)) {
      // Skip if this inherited role already has a direct permission defined.
      if (roleSet.has(inheritedRole)) continue;

      const selectPerms: NonNullable<CompiledPermission['select']>[] = [];
      const insertPerms: NonNullable<CompiledPermission['insert']>[] = [];
      const updatePerms: NonNullable<CompiledPermission['update']>[] = [];
      const deletePerms: NonNullable<CompiledPermission['delete']>[] = [];

      for (const baseRole of constituentRoles) {
        const selectKey = lookupKey(table.schema, table.name, baseRole, 'select');
        const selectPerm = map.get(selectKey)?.select;
        if (selectPerm) selectPerms.push(selectPerm);

        const insertKey = lookupKey(table.schema, table.name, baseRole, 'insert');
        const insertPerm = map.get(insertKey)?.insert;
        if (insertPerm) insertPerms.push(insertPerm);

        const updateKey = lookupKey(table.schema, table.name, baseRole, 'update');
        const updatePerm = map.get(updateKey)?.update;
        if (updatePerm) updatePerms.push(updatePerm);

        const deleteKey = lookupKey(table.schema, table.name, baseRole, 'delete');
        const deletePerm = map.get(deleteKey)?.delete;
        if (deletePerm) deletePerms.push(deletePerm);
      }

      const merged: CompiledPermission = {};
      if (selectPerms.length > 0) merged.select = mergeSelectPermissions(selectPerms);
      if (insertPerms.length > 0) merged.insert = mergeInsertPermissions(insertPerms);
      if (updatePerms.length > 0) merged.update = mergeUpdatePermissions(updatePerms);
      if (deletePerms.length > 0) merged.delete = mergeDeletePermissions(deletePerms);

      if (merged.select) map.set(lookupKey(table.schema, table.name, inheritedRole, 'select'), merged);
      if (merged.insert) map.set(lookupKey(table.schema, table.name, inheritedRole, 'insert'), merged);
      if (merged.update) map.set(lookupKey(table.schema, table.name, inheritedRole, 'update'), merged);
      if (merged.delete) map.set(lookupKey(table.schema, table.name, inheritedRole, 'delete'), merged);
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
