/**
 * Main PostgreSQL introspection module.
 *
 * Connects to a database via pg.Pool, runs system catalog queries,
 * and returns a structured IntrospectionResult.
 */

import type { Pool } from 'pg';
import type {
  ColumnInfo,
  EnumInfo,
  ForeignKeyInfo,
  FunctionInfo,
  IndexInfo,
  UniqueConstraintInfo,
} from '../types.js';
import {
  TABLES_QUERY,
  COLUMNS_QUERY,
  PRIMARY_KEYS_QUERY,
  FOREIGN_KEYS_QUERY,
  UNIQUE_CONSTRAINTS_QUERY,
  INDEXES_QUERY,
  ENUMS_QUERY,
  FUNCTIONS_QUERY,
} from './queries.js';

// ─── Result types ────────────────────────────────────────────────────────────

export interface IntrospectedTable {
  name: string;
  schema: string;
  tableType: 'BASE TABLE' | 'VIEW';
  comment?: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  uniqueConstraints: UniqueConstraintInfo[];
  indexes: IndexInfo[];
}

export interface IntrospectionResult {
  tables: IntrospectedTable[];
  enums: EnumInfo[];
  functions: FunctionInfo[];
}

// ─── Raw query row types ─────────────────────────────────────────────────────

interface TableRow {
  table_schema: string;
  table_name: string;
  table_type: string;
  comment: string | null;
}

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  comment: string | null;
  is_array: boolean;
}

interface PrimaryKeyRow {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal: number;
}

interface ForeignKeyRow {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal: number;
  ref_schema: string;
  ref_table: string;
  ref_column: string;
}

interface UniqueConstraintRow {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal: number;
}

interface IndexRow {
  table_schema: string;
  table_name: string;
  index_name: string;
  column_name: string;
  is_unique: boolean;
  ordinal: number;
}

interface EnumRow {
  enum_schema: string;
  enum_name: string;
  enum_value: string;
  sort_order: number;
}

interface FunctionRow {
  function_schema: string;
  function_name: string;
  return_type: string;
  arg_types: string[];
  arg_names: string[];
  is_set_returning: boolean;
  volatility: string;
}

// ─── Table key helper ────────────────────────────────────────────────────────

function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

// ─── Enum resolution helper ──────────────────────────────────────────────────

/**
 * Build a map from enum type name to its values, so we can annotate
 * columns that use enum types.
 */
function buildEnumMap(enums: EnumInfo[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of enums) {
    map.set(e.name, e.values);
    // Also store with schema-qualified name
    map.set(`${e.schema}.${e.name}`, e.values);
  }
  return map;
}

// ─── Main introspection function ─────────────────────────────────────────────

/**
 * Introspect a PostgreSQL database and return structured metadata.
 *
 * @param pool    - A pg.Pool connected to the target database.
 * @param schemas - Array of schema names to introspect (default: ['public']).
 */
export async function introspectDatabase(
  pool: Pool,
  schemas: string[] = ['public'],
): Promise<IntrospectionResult> {
  // Run all introspection queries in parallel for efficiency
  const [
    tablesResult,
    columnsResult,
    primaryKeysResult,
    foreignKeysResult,
    uniqueConstraintsResult,
    indexesResult,
    enumsResult,
    functionsResult,
  ] = await Promise.all([
    pool.query<TableRow>(TABLES_QUERY, [schemas]),
    pool.query<ColumnRow>(COLUMNS_QUERY, [schemas]),
    pool.query<PrimaryKeyRow>(PRIMARY_KEYS_QUERY, [schemas]),
    pool.query<ForeignKeyRow>(FOREIGN_KEYS_QUERY, [schemas]),
    pool.query<UniqueConstraintRow>(UNIQUE_CONSTRAINTS_QUERY, [schemas]),
    pool.query<IndexRow>(INDEXES_QUERY, [schemas]),
    pool.query<EnumRow>(ENUMS_QUERY, [schemas]),
    pool.query<FunctionRow>(FUNCTIONS_QUERY, [schemas]),
  ]);

  // Parse enums first — needed for column annotation
  const enums = parseEnums(enumsResult.rows);
  const enumMap = buildEnumMap(enums);

  // Parse functions
  const functions = parseFunctions(functionsResult.rows);

  // Build lookup maps for per-table data
  const primaryKeyMap = parsePrimaryKeys(primaryKeysResult.rows);
  const foreignKeyMap = parseForeignKeys(foreignKeysResult.rows);
  const uniqueConstraintMap = parseUniqueConstraints(uniqueConstraintsResult.rows);
  const indexMap = parseIndexes(indexesResult.rows);
  const columnMap = parseColumns(columnsResult.rows, enumMap);

  // Assemble tables
  const tables: IntrospectedTable[] = tablesResult.rows.map((row) => {
    const key = tableKey(row.table_schema, row.table_name);
    const pkColumns = primaryKeyMap.get(key) ?? [];
    const columns = columnMap.get(key) ?? [];

    // Mark primary key columns
    const pkSet = new Set(pkColumns);
    for (const col of columns) {
      col.isPrimaryKey = pkSet.has(col.name);
    }

    return {
      name: row.table_name,
      schema: row.table_schema,
      tableType: row.table_type as 'BASE TABLE' | 'VIEW',
      comment: row.comment ?? undefined,
      columns,
      primaryKey: pkColumns,
      foreignKeys: foreignKeyMap.get(key) ?? [],
      uniqueConstraints: uniqueConstraintMap.get(key) ?? [],
      indexes: indexMap.get(key) ?? [],
    };
  });

  return { tables, enums, functions };
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseColumns(
  rows: ColumnRow[],
  enumMap: Map<string, string[]>,
): Map<string, ColumnInfo[]> {
  const map = new Map<string, ColumnInfo[]>();

  for (const row of rows) {
    const key = tableKey(row.table_schema, row.table_name);
    if (!map.has(key)) {
      map.set(key, []);
    }

    // For array types, PG stores the element type with a leading underscore
    // in udt_name (e.g., "_text" for text[]). Strip it for the base type.
    const isArray = row.is_array || row.udt_name.startsWith('_');
    const baseUdtName = row.udt_name.startsWith('_')
      ? row.udt_name.slice(1)
      : row.udt_name;

    // Check if this column uses an enum type
    const enumValues = enumMap.get(baseUdtName) ?? undefined;

    const col: ColumnInfo = {
      name: row.column_name,
      type: row.data_type,
      udtName: baseUdtName,
      isNullable: row.is_nullable === 'YES',
      hasDefault: row.column_default !== null,
      defaultValue: row.column_default ?? undefined,
      isPrimaryKey: false, // Set later when we have PK info
      isArray,
      comment: row.comment ?? undefined,
      enumValues,
    };

    map.get(key)!.push(col);
  }

  return map;
}

function parsePrimaryKeys(rows: PrimaryKeyRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const row of rows) {
    const key = tableKey(row.table_schema, row.table_name);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(row.column_name);
  }

  return map;
}

function parseForeignKeys(rows: ForeignKeyRow[]): Map<string, ForeignKeyInfo[]> {
  // Group rows by (table, constraint) to assemble multi-column FKs
  const groupMap = new Map<string, Map<string, { fk: ForeignKeyRow[] }>>();

  for (const row of rows) {
    const tKey = tableKey(row.table_schema, row.table_name);
    if (!groupMap.has(tKey)) {
      groupMap.set(tKey, new Map());
    }
    const constraintMap = groupMap.get(tKey)!;
    if (!constraintMap.has(row.constraint_name)) {
      constraintMap.set(row.constraint_name, { fk: [] });
    }
    constraintMap.get(row.constraint_name)!.fk.push(row);
  }

  const result = new Map<string, ForeignKeyInfo[]>();

  for (const [tKey, constraintMap] of groupMap) {
    const fks: ForeignKeyInfo[] = [];
    for (const [constraintName, { fk }] of constraintMap) {
      // Sort by ordinal to get correct column order
      fk.sort((a, b) => a.ordinal - b.ordinal);
      fks.push({
        constraintName,
        columns: fk.map((r) => r.column_name),
        referencedSchema: fk[0].ref_schema,
        referencedTable: fk[0].ref_table,
        referencedColumns: fk.map((r) => r.ref_column),
      });
    }
    result.set(tKey, fks);
  }

  return result;
}

function parseUniqueConstraints(
  rows: UniqueConstraintRow[],
): Map<string, UniqueConstraintInfo[]> {
  // Group by (table, constraint)
  const groupMap = new Map<string, Map<string, string[]>>();

  for (const row of rows) {
    const tKey = tableKey(row.table_schema, row.table_name);
    if (!groupMap.has(tKey)) {
      groupMap.set(tKey, new Map());
    }
    const constraintMap = groupMap.get(tKey)!;
    if (!constraintMap.has(row.constraint_name)) {
      constraintMap.set(row.constraint_name, []);
    }
    constraintMap.get(row.constraint_name)!.push(row.column_name);
  }

  const result = new Map<string, UniqueConstraintInfo[]>();

  for (const [tKey, constraintMap] of groupMap) {
    const ucs: UniqueConstraintInfo[] = [];
    for (const [constraintName, columns] of constraintMap) {
      ucs.push({ constraintName, columns });
    }
    result.set(tKey, ucs);
  }

  return result;
}

function parseIndexes(rows: IndexRow[]): Map<string, IndexInfo[]> {
  // Group by (table, index)
  const groupMap = new Map<string, Map<string, { columns: string[]; isUnique: boolean }>>();

  for (const row of rows) {
    const tKey = tableKey(row.table_schema, row.table_name);
    if (!groupMap.has(tKey)) {
      groupMap.set(tKey, new Map());
    }
    const indexMap = groupMap.get(tKey)!;
    if (!indexMap.has(row.index_name)) {
      indexMap.set(row.index_name, { columns: [], isUnique: row.is_unique });
    }
    indexMap.get(row.index_name)!.columns.push(row.column_name);
  }

  const result = new Map<string, IndexInfo[]>();

  for (const [tKey, indexMap] of groupMap) {
    const idxs: IndexInfo[] = [];
    for (const [name, { columns, isUnique }] of indexMap) {
      idxs.push({ name, columns, isUnique });
    }
    result.set(tKey, idxs);
  }

  return result;
}

function parseEnums(rows: EnumRow[]): EnumInfo[] {
  // Group by (schema, name), preserving sort order
  const groupMap = new Map<string, { schema: string; name: string; values: string[] }>();

  for (const row of rows) {
    const key = `${row.enum_schema}.${row.enum_name}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        schema: row.enum_schema,
        name: row.enum_name,
        values: [],
      });
    }
    groupMap.get(key)!.values.push(row.enum_value);
  }

  return Array.from(groupMap.values());
}

function parseFunctions(rows: FunctionRow[]): FunctionInfo[] {
  return rows.map((row) => ({
    name: row.function_name,
    schema: row.function_schema,
    returnType: row.return_type,
    argTypes: row.arg_types ?? [],
    argNames: row.arg_names ?? [],
    isSetReturning: row.is_set_returning,
    volatility: row.volatility as 'immutable' | 'stable' | 'volatile',
  }));
}
