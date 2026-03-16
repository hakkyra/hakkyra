/**
 * Maps PostgreSQL type names to GraphQL scalar type names.
 */

/** GraphQL scalar names used in schema generation. */
export type GraphQLScalarName =
  | 'Int'
  | 'Smallint'
  | 'Float'
  | 'String'
  | 'Boolean'
  | 'Bigint'
  | 'Numeric'
  | 'Uuid'
  | 'json'
  | 'Jsonb'
  | 'Timestamptz'
  | 'Timestamp'
  | 'Date'
  | 'Time'
  | 'Interval'
  | 'Bytea'
  | 'Inet'
  | 'Bpchar';

export interface GraphQLTypeName {
  /** The base scalar or enum name, e.g. "Int", "String", "MyEnum" */
  name: string;
  /** Whether this is a list type, e.g. [String] */
  isList: boolean;
  /** Whether this is a custom scalar (not built-in GraphQL) */
  isCustomScalar: boolean;
}

/**
 * PostgreSQL types that are stringified when `stringify_numeric_types` is enabled.
 * These types don't fit cleanly into the IEEE-754 spec for JSON encoding/decoding.
 */
const STRINGIFY_NUMERIC_OVERRIDES: Record<string, { name: string; isCustomScalar: boolean }> = {
  int8: { name: 'String', isCustomScalar: false },
  bigint: { name: 'String', isCustomScalar: false },
  bigserial: { name: 'String', isCustomScalar: false },
  serial8: { name: 'String', isCustomScalar: false },
  float8: { name: 'String', isCustomScalar: false },
  'double precision': { name: 'String', isCustomScalar: false },
  numeric: { name: 'String', isCustomScalar: false },
  money: { name: 'String', isCustomScalar: false },
};

let stringifyNumericOverrides: Record<string, { name: string; isCustomScalar: boolean }> | null = null;

/**
 * Enable or disable stringification of numeric types (bigint, numeric, double precision).
 * When enabled, these types map to GraphQL `String` instead of their usual scalar types.
 * Call this before schema generation.
 */
export function configureStringifyNumericTypes(enabled: boolean): void {
  stringifyNumericOverrides = enabled ? STRINGIFY_NUMERIC_OVERRIDES : null;
}

/**
 * Check if a PostgreSQL column type should be cast to text in SQL output
 * when `stringify_numeric_types` is enabled. This ensures values like
 * "0.0000000000" are preserved as-is in json_build_object() output
 * instead of being truncated by JSON number parsing.
 */
export function shouldCastToText(udtName: string): boolean {
  if (!stringifyNumericOverrides) return false;
  const baseType = udtName.startsWith('_') ? udtName.slice(1) : udtName;
  return baseType in stringifyNumericOverrides;
}

/**
 * Mapping from PostgreSQL udt_name (without leading underscore for arrays)
 * to GraphQL scalar name and whether it's custom.
 */
const PG_TO_GRAPHQL: Record<string, { name: string; isCustomScalar: boolean }> = {
  // Integer types
  int2: { name: 'Smallint', isCustomScalar: true },
  smallint: { name: 'Smallint', isCustomScalar: true },
  int4: { name: 'Int', isCustomScalar: false },
  integer: { name: 'Int', isCustomScalar: false },
  serial: { name: 'Int', isCustomScalar: false },
  serial4: { name: 'Int', isCustomScalar: false },

  // Big integer
  int8: { name: 'Bigint', isCustomScalar: true },
  bigint: { name: 'Bigint', isCustomScalar: true },
  bigserial: { name: 'Bigint', isCustomScalar: true },
  serial8: { name: 'Bigint', isCustomScalar: true },

  // Floating point
  float4: { name: 'Float', isCustomScalar: false },
  real: { name: 'Float', isCustomScalar: false },
  float8: { name: 'Float', isCustomScalar: false },
  'double precision': { name: 'Float', isCustomScalar: false },
  numeric: { name: 'Numeric', isCustomScalar: true },
  money: { name: 'Numeric', isCustomScalar: true },

  // Boolean
  bool: { name: 'Boolean', isCustomScalar: false },
  boolean: { name: 'Boolean', isCustomScalar: false },

  // String types
  text: { name: 'String', isCustomScalar: false },
  varchar: { name: 'String', isCustomScalar: false },
  'character varying': { name: 'String', isCustomScalar: false },
  char: { name: 'String', isCustomScalar: false },
  character: { name: 'String', isCustomScalar: false },
  bpchar: { name: 'Bpchar', isCustomScalar: true },
  name: { name: 'String', isCustomScalar: false },
  citext: { name: 'String', isCustomScalar: false },
  xml: { name: 'String', isCustomScalar: false },

  // UUID
  uuid: { name: 'Uuid', isCustomScalar: true },

  // JSON
  json: { name: 'json', isCustomScalar: true },
  jsonb: { name: 'Jsonb', isCustomScalar: true },

  // Timestamps & dates
  timestamp: { name: 'Timestamp', isCustomScalar: true },
  'timestamp without time zone': { name: 'Timestamp', isCustomScalar: true },
  timestamptz: { name: 'Timestamptz', isCustomScalar: true },
  'timestamp with time zone': { name: 'Timestamptz', isCustomScalar: true },
  date: { name: 'Date', isCustomScalar: true },
  time: { name: 'Time', isCustomScalar: true },
  'time without time zone': { name: 'Time', isCustomScalar: true },
  timetz: { name: 'Time', isCustomScalar: true },
  'time with time zone': { name: 'Time', isCustomScalar: true },
  interval: { name: 'Interval', isCustomScalar: true },

  // Binary
  bytea: { name: 'Bytea', isCustomScalar: true },

  // Network
  inet: { name: 'Inet', isCustomScalar: true },
  cidr: { name: 'Inet', isCustomScalar: true },
  macaddr: { name: 'String', isCustomScalar: false },

  // Geometric (expose as json for now)
  point: { name: 'json', isCustomScalar: true },
  line: { name: 'json', isCustomScalar: true },
  lseg: { name: 'json', isCustomScalar: true },
  box: { name: 'json', isCustomScalar: true },
  path: { name: 'json', isCustomScalar: true },
  polygon: { name: 'json', isCustomScalar: true },
  circle: { name: 'json', isCustomScalar: true },

  // OID
  oid: { name: 'Int', isCustomScalar: false },
};

/**
 * Map a PostgreSQL type to a GraphQL type name.
 *
 * @param pgType   - The PostgreSQL udt_name (e.g. "int4", "varchar", "my_enum").
 *                   Array types have a leading underscore stripped by the caller
 *                   before passing.
 * @param isArray  - Whether the column is an array type.
 * @param enumNames - Set of known enum type names, so we can map them correctly.
 */
export function pgTypeToGraphQL(
  pgType: string,
  isArray: boolean,
  enumNames?: Set<string>,
): GraphQLTypeName {
  // Strip leading underscore from array element type (PG convention: _int4 => int4)
  const baseType = pgType.startsWith('_') ? pgType.slice(1) : pgType;

  // Check if it's a known enum
  if (enumNames?.has(baseType)) {
    return {
      name: pgEnumToGraphQLName(baseType),
      isList: isArray,
      isCustomScalar: false, // enums are not scalars, they're enum types
    };
  }

  const mapping = PG_TO_GRAPHQL[baseType];
  if (mapping) {
    return {
      name: mapping.name,
      isList: isArray,
      isCustomScalar: mapping.isCustomScalar,
    };
  }

  // Unknown type — fall back to String
  return {
    name: 'String',
    isList: isArray,
    isCustomScalar: false,
  };
}

/**
 * Convert a PostgreSQL enum type name to a GraphQL enum name.
 * Converts snake_case to PascalCase, e.g. "user_role" → "UserRole".
 */
export function pgEnumToGraphQLName(pgName: string): string {
  return pgName
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

/**
 * Check if a PostgreSQL type name is a known scalar type (not a table/composite).
 * Returns true for types like int4, text, jsonb, uuid, etc.
 * Returns false for unknown types (e.g., table names like 'player_risk').
 */
export function isKnownPgScalarType(pgType: string): boolean {
  const baseType = pgType.startsWith('_') ? pgType.slice(1) : pgType;
  return baseType in PG_TO_GRAPHQL;
}

/**
 * Returns the set of all custom scalar names used in the type map.
 * Useful for registering custom scalars in the GraphQL schema.
 */
export function getCustomScalarNames(): Set<string> {
  const scalars = new Set<string>();
  for (const mapping of Object.values(PG_TO_GRAPHQL)) {
    if (mapping.isCustomScalar) {
      scalars.add(mapping.name);
    }
  }
  return scalars;
}
