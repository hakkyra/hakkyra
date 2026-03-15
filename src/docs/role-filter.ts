/**
 * Role-aware table filtering for documentation endpoints.
 *
 * Filters tables, columns, and CRUD operations based on the requesting
 * role's permissions. Used by OpenAPI, LLM doc, and SDL endpoints.
 */

import type { TableInfo, ColumnInfo } from '../types.js';
import type { PermissionLookup } from '../permissions/lookup.js';

export type CrudOperation = 'select' | 'insert' | 'update' | 'delete';

export interface RoleFilteredTable {
  table: TableInfo;
  allowedColumns: string[];
  allowedOperations: Set<CrudOperation>;
}

export interface FilterResult {
  /** TableInfo[] with columns pruned to only those the role can see */
  tables: TableInfo[];
  /** Per-table operation metadata for doc generators */
  operationMap: Map<string, Set<CrudOperation>>;
}

/**
 * Filter tables, columns, and CRUD operations for a specific role.
 *
 * - Admin: returns all tables unfiltered.
 * - Other roles: only tables with at least one permission, columns from select permission,
 *   and only CRUD operations that the role has permission for.
 * - Tables with `queryRootFields: []` are excluded (hidden from root-level access).
 */
export function filterTablesForRole(
  tables: TableInfo[],
  role: string,
  permissionLookup: PermissionLookup,
  isAdmin: boolean,
): FilterResult {
  if (isAdmin) {
    const operationMap = new Map<string, Set<CrudOperation>>();
    for (const table of tables) {
      operationMap.set(table.name, new Set(['select', 'insert', 'update', 'delete']));
    }
    return { tables, operationMap };
  }

  const filteredTables: TableInfo[] = [];
  const operationMap = new Map<string, Set<CrudOperation>>();

  for (const table of tables) {
    const ops = new Set<CrudOperation>();

    const selectPerm = permissionLookup.get(table.name, table.schema, role, 'select');
    if (selectPerm?.select) {
      // Check queryRootFields — if it's an empty array, this table is hidden from root queries
      if (
        selectPerm.select.queryRootFields !== undefined &&
        selectPerm.select.queryRootFields.length === 0
      ) {
        continue; // Skip this table entirely for doc purposes
      }
      ops.add('select');
    }

    const insertPerm = permissionLookup.get(table.name, table.schema, role, 'insert');
    if (insertPerm?.insert) ops.add('insert');

    const updatePerm = permissionLookup.get(table.name, table.schema, role, 'update');
    if (updatePerm?.update) ops.add('update');

    const deletePerm = permissionLookup.get(table.name, table.schema, role, 'delete');
    if (deletePerm?.delete) ops.add('delete');

    // Skip tables with no permissions at all
    if (ops.size === 0) continue;

    // Filter columns to those in the select permission
    let filteredColumns: ColumnInfo[] = table.columns;
    if (selectPerm?.select && selectPerm.select.columns !== '*') {
      const allowedCols = new Set(selectPerm.select.columns);
      // Always include PK columns (needed for get-by-pk, update, delete endpoints)
      for (const pk of table.primaryKey) allowedCols.add(pk);
      filteredColumns = table.columns.filter((c) => allowedCols.has(c.name));
    }

    // Filter relationships to only include those whose remote table is accessible
    const accessibleTableNames = new Set<string>();
    for (const t of tables) {
      const remotePerm = permissionLookup.get(t.name, t.schema, role, 'select');
      if (remotePerm?.select) accessibleTableNames.add(t.name);
    }
    const filteredRelationships = table.relationships.filter((rel) =>
      accessibleTableNames.has(rel.remoteTable.name),
    );

    const filteredTable: TableInfo = {
      ...table,
      columns: filteredColumns,
      relationships: filteredRelationships,
    };

    filteredTables.push(filteredTable);
    operationMap.set(table.name, ops);
  }

  return { tables: filteredTables, operationMap };
}
