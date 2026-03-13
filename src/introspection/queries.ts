/**
 * Raw SQL queries for introspecting PostgreSQL system catalogs.
 *
 * All queries accept a `schemas` parameter ($1 = text[]) to filter
 * by one or more schema names.
 */

// ─── Tables & Views ─────────────────────────────────────────────────────────

/**
 * Returns tables and views in the given schemas.
 *
 * Columns: table_schema, table_name, table_type, comment
 */
export const TABLES_QUERY = `
  SELECT
    t.table_schema,
    t.table_name,
    t.table_type,
    pgd.description AS comment
  FROM information_schema.tables t
  LEFT JOIN pg_catalog.pg_class c
    ON c.relname = t.table_name
  LEFT JOIN pg_catalog.pg_namespace n
    ON n.oid = c.relnamespace
    AND n.nspname = t.table_schema
  LEFT JOIN pg_catalog.pg_description pgd
    ON pgd.objoid = c.oid
    AND pgd.objsubid = 0
  WHERE t.table_schema = ANY($1)
    AND t.table_type IN ('BASE TABLE', 'VIEW')

  UNION ALL

  SELECT
    n.nspname AS table_schema,
    c.relname AS table_name,
    'MATERIALIZED VIEW' AS table_type,
    pgd.description AS comment
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_description pgd
    ON pgd.objoid = c.oid AND pgd.objsubid = 0
  WHERE n.nspname = ANY($1)
    AND c.relkind = 'm'

  ORDER BY table_schema, table_name;
`;

// ─── Columns ─────────────────────────────────────────────────────────────────

/**
 * Returns columns with type information, nullability, defaults, and comments.
 *
 * Columns: table_schema, table_name, column_name, ordinal_position,
 *          data_type, udt_name, is_nullable, column_default, comment, is_array
 */
export const COLUMNS_QUERY = `
  SELECT
    c.table_schema,
    c.table_name,
    c.column_name,
    c.ordinal_position,
    c.data_type,
    c.udt_name,
    c.is_nullable,
    c.column_default,
    pgd.description AS comment,
    CASE WHEN c.data_type = 'ARRAY' THEN true ELSE false END AS is_array
  FROM information_schema.columns c
  LEFT JOIN pg_catalog.pg_class cl
    ON cl.relname = c.table_name
  LEFT JOIN pg_catalog.pg_namespace ns
    ON ns.oid = cl.relnamespace
    AND ns.nspname = c.table_schema
  LEFT JOIN pg_catalog.pg_description pgd
    ON pgd.objoid = cl.oid
    AND pgd.objsubid = c.ordinal_position
  WHERE c.table_schema = ANY($1)

  UNION ALL

  -- Materialized view columns (not in information_schema)
  SELECT
    n.nspname AS table_schema,
    c.relname AS table_name,
    a.attname AS column_name,
    a.attnum AS ordinal_position,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
    t.typname AS udt_name,
    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
    NULL AS column_default,
    pgd.description AS comment,
    CASE WHEN t.typname LIKE '\\_%' THEN true ELSE false END AS is_array
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_catalog.pg_description pgd
    ON pgd.objoid = c.oid AND pgd.objsubid = a.attnum
  WHERE n.nspname = ANY($1)
    AND c.relkind = 'm'
    AND a.attnum > 0
    AND NOT a.attisdropped

  ORDER BY table_schema, table_name, ordinal_position;
`;

// ─── Primary Keys ────────────────────────────────────────────────────────────

/**
 * Returns primary key columns for each table.
 *
 * Columns: table_schema, table_name, constraint_name, column_name, ordinal
 */
export const PRIMARY_KEYS_QUERY = `
  SELECT
    n.nspname AS table_schema,
    cl.relname AS table_name,
    con.conname AS constraint_name,
    a.attname AS column_name,
    array_position(con.conkey, a.attnum) AS ordinal
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class cl
    ON cl.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n
    ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = con.conrelid
    AND a.attnum = ANY(con.conkey)
  WHERE con.contype = 'p'
    AND n.nspname = ANY($1)
  ORDER BY n.nspname, cl.relname, array_position(con.conkey, a.attnum);
`;

// ─── Foreign Keys ────────────────────────────────────────────────────────────

/**
 * Returns foreign key constraints with local and referenced columns.
 *
 * Columns: table_schema, table_name, constraint_name,
 *          column_name, ordinal,
 *          ref_schema, ref_table, ref_column
 */
export const FOREIGN_KEYS_QUERY = `
  SELECT
    n.nspname  AS table_schema,
    cl.relname AS table_name,
    con.conname AS constraint_name,
    a.attname  AS column_name,
    array_position(con.conkey, a.attnum) AS ordinal,
    rn.nspname AS ref_schema,
    rcl.relname AS ref_table,
    ra.attname AS ref_column
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class cl
    ON cl.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n
    ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_class rcl
    ON rcl.oid = con.confrelid
  JOIN pg_catalog.pg_namespace rn
    ON rn.oid = rcl.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = con.conrelid
    AND a.attnum = ANY(con.conkey)
  JOIN pg_catalog.pg_attribute ra
    ON ra.attrelid = con.confrelid
    AND ra.attnum = con.confkey[array_position(con.conkey, a.attnum)]
  WHERE con.contype = 'f'
    AND n.nspname = ANY($1)
  ORDER BY n.nspname, cl.relname, con.conname, array_position(con.conkey, a.attnum);
`;

// ─── Unique Constraints ──────────────────────────────────────────────────────

/**
 * Returns unique constraints (not including primary keys).
 *
 * Columns: table_schema, table_name, constraint_name, column_name, ordinal
 */
export const UNIQUE_CONSTRAINTS_QUERY = `
  SELECT
    n.nspname AS table_schema,
    cl.relname AS table_name,
    con.conname AS constraint_name,
    a.attname AS column_name,
    array_position(con.conkey, a.attnum) AS ordinal
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class cl
    ON cl.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n
    ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = con.conrelid
    AND a.attnum = ANY(con.conkey)
  WHERE con.contype = 'u'
    AND n.nspname = ANY($1)
  ORDER BY n.nspname, cl.relname, con.conname, array_position(con.conkey, a.attnum);
`;

// ─── Indexes ─────────────────────────────────────────────────────────────────

/**
 * Returns indexes with their columns and uniqueness.
 *
 * Columns: table_schema, table_name, index_name, column_name, is_unique, ordinal
 */
export const INDEXES_QUERY = `
  SELECT
    n.nspname AS table_schema,
    ct.relname AS table_name,
    ci.relname AS index_name,
    a.attname AS column_name,
    ix.indisunique AS is_unique,
    array_position(ix.indkey, a.attnum) AS ordinal
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class ci
    ON ci.oid = ix.indexrelid
  JOIN pg_catalog.pg_class ct
    ON ct.oid = ix.indrelid
  JOIN pg_catalog.pg_namespace n
    ON n.oid = ct.relnamespace
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = ct.oid
    AND a.attnum = ANY(ix.indkey)
    AND a.attnum > 0
  WHERE n.nspname = ANY($1)
    AND NOT ix.indisprimary
  ORDER BY n.nspname, ct.relname, ci.relname, array_position(ix.indkey, a.attnum);
`;

// ─── Enums ───────────────────────────────────────────────────────────────────

/**
 * Returns enum types with their values, ordered by sort position.
 *
 * Columns: enum_schema, enum_name, enum_value, sort_order
 */
export const ENUMS_QUERY = `
  SELECT
    n.nspname AS enum_schema,
    t.typname AS enum_name,
    e.enumlabel AS enum_value,
    e.enumsortorder AS sort_order
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_enum e
    ON e.enumtypid = t.oid
  JOIN pg_catalog.pg_namespace n
    ON n.oid = t.typnamespace
  WHERE n.nspname = ANY($1)
  ORDER BY n.nspname, t.typname, e.enumsortorder;
`;

// ─── Functions (for computed fields / custom queries) ────────────────────────

/**
 * Returns non-aggregate, non-window functions that take a table row type
 * as their first argument (suitable for computed fields), plus other stable/
 * immutable functions.
 *
 * Columns: function_schema, function_name, return_type, arg_types, arg_names,
 *          is_set_returning, volatility
 */
export const FUNCTIONS_QUERY = `
  SELECT
    n.nspname AS function_schema,
    p.proname AS function_name,
    pg_catalog.format_type(p.prorettype, NULL) AS return_type,
    COALESCE(
      array_agg(pg_catalog.format_type(unnested.type_oid, NULL) ORDER BY unnested.ord),
      '{}'
    ) AS arg_types,
    COALESCE(p.proargnames, '{}') AS arg_names,
    p.proretset AS is_set_returning,
    CASE p.provolatile
      WHEN 'i' THEN 'immutable'
      WHEN 's' THEN 'stable'
      WHEN 'v' THEN 'volatile'
    END AS volatility
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n
    ON n.oid = p.pronamespace
  LEFT JOIN LATERAL unnest(p.proargtypes) WITH ORDINALITY AS unnested(type_oid, ord) ON true
  WHERE n.nspname = ANY($1)
    AND p.prokind = 'f'
  GROUP BY n.nspname, p.proname, p.prorettype, p.proretset, p.provolatile, p.proargnames
  ORDER BY n.nspname, p.proname;
`;
