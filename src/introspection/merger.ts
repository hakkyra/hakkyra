/**
 * Merges introspection results with YAML configuration to produce
 * the unified SchemaModel used by the rest of Hakkyra.
 */

import type { Pool } from 'pg';
import type {
  EnumInfo,
  ForeignKeyInfo,
  HakkyraConfig,
  RelationshipConfig,
  SchemaModel,
  TableInfo,
  TablePermissions,
} from '../types.js';
import type { IntrospectedTable, IntrospectionResult } from './introspector.js';
import { quoteIdentifier } from '../sql/utils.js';
import { toCamelCase } from '../shared/naming.js';

// ─── Warnings ────────────────────────────────────────────────────────────────

export interface MergeWarning {
  type: 'missing_table' | 'missing_column' | 'unused_config';
  message: string;
}

export interface MergeResult {
  model: SchemaModel;
  warnings: MergeWarning[];
}

// ─── Default (empty) permissions ────────────────────────────────────────────

function emptyPermissions(): TablePermissions {
  return {
    select: {},
    insert: {},
    update: {},
    delete: {},
  };
}

// ─── Pluralization helper ───────────────────────────────────────────────────

/**
 * Naive pluralization for auto-generated array relationship names.
 * Handles common English patterns; falls back to appending "s".
 */
function pluralize(name: string): string {
  if (name.endsWith('s') || name.endsWith('x') || name.endsWith('z') ||
      name.endsWith('sh') || name.endsWith('ch')) {
    return name + 'es';
  }
  if (name.endsWith('y') && name.length > 1) {
    const beforeY = name[name.length - 2];
    if (!'aeiou'.includes(beforeY)) {
      return name.slice(0, -1) + 'ies';
    }
  }
  return name + 's';
}

// ─── Relationship naming from FK ────────────────────────────────────────────

/**
 * Derive a relationship name for an object relationship from a FK constraint.
 *
 * Strategy:
 *  - For single-column FKs like "user_id" → strip "_id" → "user"
 *  - For single-column FKs like "author" → use as-is → "author"
 *  - For multi-column FKs, use the referenced table name
 *  - If the name collides with a column name, suffix with "_rel"
 */
function objectRelNameFromFK(fk: ForeignKeyInfo, columnNames: Set<string>): string {
  let name: string;

  if (fk.columns.length === 1) {
    const col = fk.columns[0];
    if (col.endsWith('_id')) {
      name = col.slice(0, -3);
    } else {
      name = fk.referencedTable;
    }
  } else {
    name = fk.referencedTable;
  }

  // Avoid collision with column names
  if (columnNames.has(name)) {
    name = name + '_rel';
  }

  return name;
}

/**
 * Derive a relationship name for an array relationship.
 *
 * Strategy: pluralize the referencing table name.
 * If the FK column doesn't end with _id (non-standard FK), include the
 * column name to disambiguate (e.g., "comments_by_author_id").
 */
function arrayRelNameFromFK(
  fk: ForeignKeyInfo,
  referencingTable: string,
  columnNames: Set<string>,
): string {
  let name = pluralize(referencingTable);

  // If there are multiple FKs from the same table to this table,
  // disambiguation will happen in the dedup step. Here we generate
  // a base name.

  // Avoid collision with column names
  if (columnNames.has(name)) {
    name = name + '_rel';
  }

  return name;
}

// ─── Auto-detect relationships from foreign keys ────────────────────────────

/**
 * Build relationship configs for a table from its foreign keys.
 * Generates both object rels (on the FK-owning table) and array rels
 * (on the referenced table).
 */
function autoDetectRelationships(
  tables: IntrospectedTable[],
): Map<string, RelationshipConfig[]> {
  const result = new Map<string, RelationshipConfig[]>();
  const tableColumnNames = new Map<string, Set<string>>();

  // Pre-build column name sets for collision checks
  for (const table of tables) {
    const key = `${table.schema}.${table.name}`;
    tableColumnNames.set(key, new Set(table.columns.map((c) => c.name)));
  }

  // Track names per table for deduplication
  const usedNames = new Map<string, Map<string, number>>();

  function getOrInit(key: string): RelationshipConfig[] {
    if (!result.has(key)) {
      result.set(key, []);
    }
    return result.get(key)!;
  }

  function getUsedNames(key: string): Map<string, number> {
    if (!usedNames.has(key)) {
      usedNames.set(key, new Map());
    }
    return usedNames.get(key)!;
  }

  function dedup(tableKey: string, baseName: string): string {
    const names = getUsedNames(tableKey);
    const count = names.get(baseName) ?? 0;
    names.set(baseName, count + 1);
    return count === 0 ? baseName : `${baseName}_${count + 1}`;
  }

  for (const table of tables) {
    const ownerKey = `${table.schema}.${table.name}`;
    const ownerColumns = tableColumnNames.get(ownerKey) ?? new Set();

    for (const fk of table.foreignKeys) {
      const refKey = `${fk.referencedSchema}.${fk.referencedTable}`;
      const refColumns = tableColumnNames.get(refKey) ?? new Set();

      // Object relationship on the FK-owning table
      const objRelBaseName = objectRelNameFromFK(fk, ownerColumns);
      const objRelName = dedup(ownerKey, objRelBaseName);
      getOrInit(ownerKey).push({
        name: objRelName,
        type: 'object',
        remoteTable: { name: fk.referencedTable, schema: fk.referencedSchema },
        localColumns: fk.columns,
        remoteColumns: fk.referencedColumns,
      });

      // Array relationship on the referenced table
      const arrRelBaseName = arrayRelNameFromFK(fk, table.name, refColumns);
      const arrRelName = dedup(refKey, arrRelBaseName);
      getOrInit(refKey).push({
        name: arrRelName,
        type: 'array',
        remoteTable: { name: table.name, schema: table.schema },
        localColumns: fk.referencedColumns,
        remoteColumns: fk.columns,
      });
    }
  }

  return result;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Merge introspection results with the YAML config to build a unified SchemaModel.
 *
 * @param introspection - Result from introspectDatabase()
 * @param config        - Parsed HakkyraConfig from YAML
 * @returns MergeResult with the schema model and any warnings
 */
export function mergeSchemaModel(
  introspection: IntrospectionResult,
  config: HakkyraConfig,
): MergeResult {
  const warnings: MergeWarning[] = [];

  // Build a lookup map of introspected tables
  const introspectedMap = new Map<string, IntrospectedTable>();
  for (const table of introspection.tables) {
    introspectedMap.set(`${table.schema}.${table.name}`, table);
  }

  // Auto-detect relationships from FK constraints
  const autoRelationships = autoDetectRelationships(introspection.tables);

  // Build a lookup map of config tables by schema.name
  const configTableMap = new Map<string, TableInfo>();
  for (const ct of config.tables) {
    configTableMap.set(`${ct.schema}.${ct.name}`, ct);
  }

  // Check for tables tracked in config but missing from DB
  for (const ct of config.tables) {
    const key = `${ct.schema}.${ct.name}`;
    if (!introspectedMap.has(key)) {
      warnings.push({
        type: 'missing_table',
        message: `Table "${key}" is tracked in config but does not exist in the database.`,
      });
    }
  }

  // Build the merged table list
  const mergedTables: TableInfo[] = [];

  for (const introspected of introspection.tables) {
    const key = `${introspected.schema}.${introspected.name}`;
    const configTable = configTableMap.get(key);

    // Validate column references in permissions
    if (configTable) {
      const columnNames = new Set(introspected.columns.map((c) => c.name));
      validatePermissionColumns(configTable, columnNames, warnings);
    }

    // Merge relationships: start with auto-detected, then overlay config-defined
    const autoRels = autoRelationships.get(key) ?? [];
    const configRels = configTable?.relationships ?? [];
    const mergedRels = mergeRelationships(autoRels, configRels);

    // Determine the alias
    const alias = config.tableAliases?.[introspected.name]
      ?? configTable?.alias
      ?? undefined;

    const tableInfo: TableInfo = {
      name: introspected.name,
      schema: introspected.schema,
      alias,
      comment: introspected.comment,
      columns: introspected.columns,
      primaryKey: introspected.primaryKey,
      foreignKeys: introspected.foreignKeys,
      uniqueConstraints: introspected.uniqueConstraints,
      indexes: introspected.indexes,
      relationships: mergedRels,
      permissions: configTable?.permissions ?? emptyPermissions(),
      eventTriggers: configTable?.eventTriggers ?? [],
      customRootFields: configTable?.customRootFields,
      computedFields: configTable?.computedFields,
      isEnum: configTable?.isEnum,
      isView: introspected.tableType !== 'BASE TABLE' || undefined,
    };

    mergedTables.push(tableInfo);
  }

  // Post-process: infer missing localColumns for array relationships.
  // When a config-defined array relationship has remoteColumns (the FK columns
  // on the remote table) but no localColumns (the referenced PK/unique columns
  // on this table), look up the FK constraint on the remote table to fill in
  // the gap.
  const mergedTableMap = new Map<string, TableInfo>();
  for (const t of mergedTables) {
    mergedTableMap.set(`${t.schema}.${t.name}`, t);
  }

  for (const table of mergedTables) {
    for (const rel of table.relationships) {
      if (
        rel.type === 'array' &&
        rel.remoteColumns?.length &&
        !rel.localColumns?.length
      ) {
        // Find the remote table's FK constraints
        const remoteKey = `${rel.remoteTable.schema}.${rel.remoteTable.name}`;
        const remoteTable = mergedTableMap.get(remoteKey);
        if (!remoteTable) continue;

        // Find the FK on the remote table whose columns match rel.remoteColumns
        // and which references the current table
        const matchingFK = remoteTable.foreignKeys.find((fk) => {
          if (fk.referencedSchema !== table.schema || fk.referencedTable !== table.name) {
            return false;
          }
          if (fk.columns.length !== rel.remoteColumns!.length) {
            return false;
          }
          // Check that FK columns match remoteColumns (order-sensitive)
          return fk.columns.every((col, i) => col === rel.remoteColumns![i]);
        });

        if (matchingFK) {
          rel.localColumns = matchingFK.referencedColumns;
        }
      }
    }
  }

  const model: SchemaModel = {
    tables: mergedTables,
    enums: introspection.enums,
    functions: introspection.functions,
    trackedFunctions: config.trackedFunctions ?? [],
    nativeQueries: config.nativeQueries ?? [],
    logicalModels: config.logicalModels ?? [],
  };

  return { model, warnings };
}

// ─── Relationship merging ───────────────────────────────────────────────────

/**
 * Merge auto-detected relationships with config-defined ones.
 * Config-defined relationships override auto-detected ones with the same name.
 * Config-defined relationships are also appended if they have new names.
 */
function mergeRelationships(
  autoRels: RelationshipConfig[],
  configRels: RelationshipConfig[],
): RelationshipConfig[] {
  // Match by camelCase-normalized name so "limit_type" matches "limitType"
  const autoRelMap = new Map(autoRels.map((r) => [toCamelCase(r.name), r]));
  const configRelNames = new Set(configRels.map((r) => toCamelCase(r.name)));

  // Start with auto-detected rels that aren't overridden by config
  const merged: RelationshipConfig[] = autoRels.filter(
    (r) => !configRelNames.has(toCamelCase(r.name)),
  );

  // Build a lookup from localColumns key to auto-detected rels for FK resolution
  const autoRelByColumns = new Map<string, RelationshipConfig>();
  for (const r of autoRels) {
    if (r.localColumns?.length) {
      autoRelByColumns.set(r.localColumns.join(','), r);
    }
  }

  // Add config-defined rels, filling in missing fields from auto-detected
  for (const configRel of configRels) {
    // Match by name first
    let autoRel = autoRelMap.get(toCamelCase(configRel.name));

    // If no name match but config rel has unresolved remoteTable (from FK string form),
    // try matching by localColumns to find the auto-detected counterpart
    if (!autoRel && !configRel.remoteTable?.name && configRel.localColumns?.length) {
      autoRel = autoRelByColumns.get(configRel.localColumns.join(','));
    }

    if (autoRel) {
      // Merge: config takes precedence, but fill gaps from auto-detected
      merged.push({
        ...autoRel,
        ...configRel,
        remoteTable: configRel.remoteTable?.name
          ? configRel.remoteTable
          : autoRel.remoteTable,
        localColumns: configRel.localColumns?.length
          ? configRel.localColumns
          : autoRel.localColumns,
        remoteColumns: configRel.remoteColumns?.length
          ? configRel.remoteColumns
          : autoRel.remoteColumns,
      });
    } else {
      merged.push(configRel);
    }
  }

  return merged;
}

// ─── Permission validation ──────────────────────────────────────────────────

/**
 * Check that permission column references actually exist on the table.
 */
function validatePermissionColumns(
  configTable: TableInfo,
  columnNames: Set<string>,
  warnings: MergeWarning[],
): void {
  const tableRef = `${configTable.schema}.${configTable.name}`;
  const { permissions } = configTable;

  // Helper to check a column list
  function checkColumns(
    columns: string[] | '*',
    context: string,
  ): void {
    if (columns === '*') return;
    for (const col of columns) {
      if (!columnNames.has(col)) {
        warnings.push({
          type: 'missing_column',
          message: `Permission ${context} on "${tableRef}" references non-existent column "${col}".`,
        });
      }
    }
  }

  // Select permissions
  for (const [role, perm] of Object.entries(permissions.select)) {
    checkColumns(perm.columns, `select[${role}]`);
  }

  // Insert permissions
  for (const [role, perm] of Object.entries(permissions.insert)) {
    checkColumns(perm.columns, `insert[${role}]`);
  }

  // Update permissions
  for (const [role, perm] of Object.entries(permissions.update)) {
    checkColumns(perm.columns, `update[${role}]`);
  }
}

// ─── Table-based enum resolution ────────────────────────────────────────────

/**
 * Resolve Hasura-style table-based enums (is_enum: true).
 *
 * 1. Query each enum table to get its values (from the PK column).
 * 2. Add EnumInfo entries to the schema model.
 * 3. For columns with a FK to an enum table, override their udtName
 *    so the existing type-mapping code treats them as enum columns.
 * 4. Remove auto-detected relationships that point to enum tables
 *    (the FK becomes an enum-typed scalar, not a relationship).
 */
export async function resolveTableEnums(
  model: SchemaModel,
  pool: Pool,
): Promise<void> {
  // Collect enum tables: { "public.my_enum_table" → TableInfo }
  const enumTables = new Map<string, TableInfo>();
  for (const table of model.tables) {
    if (table.isEnum) {
      enumTables.set(`${table.schema}.${table.name}`, table);
    }
  }

  if (enumTables.size === 0) return;

  // Query each enum table to get its values
  for (const [key, table] of enumTables) {
    // The PK column provides the enum values
    const pkCol = table.primaryKey[0];
    if (!pkCol) {
      console.warn(`[hakkyra:enum] Enum table "${key}" has no primary key, skipping.`);
      continue;
    }

    try {
      const result = await pool.query(
        `SELECT ${quoteIdentifier(pkCol)} AS "value" FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} ORDER BY ${quoteIdentifier(pkCol)}`,
      );
      const values = result.rows.map((row: Record<string, unknown>) => String(row.value));

      model.enums.push({
        name: table.name,
        schema: table.schema,
        values,
      });
    } catch (err) {
      console.warn(`[hakkyra:enum] Failed to query enum table "${key}":`, err);
    }
  }

  // Build a set of enum table keys for quick lookup
  const enumTableKeys = new Set(enumTables.keys());

  // For each non-enum table, remap FK columns and remove enum-table relationships
  for (const table of model.tables) {
    if (table.isEnum) continue;

    for (const fk of table.foreignKeys) {
      const refKey = `${fk.referencedSchema}.${fk.referencedTable}`;
      if (!enumTableKeys.has(refKey)) continue;

      // Single-column FK to an enum table → remap the column's udtName
      if (fk.columns.length === 1) {
        const col = table.columns.find((c) => c.name === fk.columns[0]);
        if (col) {
          col.udtName = fk.referencedTable;
        }
      }
    }

    // Remove relationships that point to enum tables
    table.relationships = table.relationships.filter((rel) => {
      const remoteKey = `${rel.remoteTable.schema}.${rel.remoteTable.name}`;
      return !enumTableKeys.has(remoteKey);
    });
  }

  // Remove enum tables from the tables list (they're not queryable types)
  model.tables = model.tables.filter((t) => !t.isEnum);
}
