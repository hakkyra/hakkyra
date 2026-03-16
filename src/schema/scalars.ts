/**
 * Custom GraphQL scalar types for PostgreSQL type mappings.
 *
 * Each scalar handles serialization (DB → client), parsing (client → DB),
 * and literal parsing (inline GraphQL values).
 */

import { GraphQLScalarType, Kind } from 'graphql';
import type { GraphQLScalarSerializer, GraphQLScalarValueParser, GraphQLScalarLiteralParser } from 'graphql';

// ─── Type Helper ─────────────────────────────────────────────────────────────

/**
 * Safely cast a GraphQL.js built-in scalar (which has type
 * `GraphQLScalarType<unknown, unknown>`) to the plain `GraphQLScalarType`
 * alias used throughout our schema code.
 *
 * This eliminates the need for `as unknown as GraphQLScalarType` casts
 * scattered across schema files.
 */
export function asScalar(scalar: GraphQLScalarType<unknown, unknown>): GraphQLScalarType {
  return scalar as GraphQLScalarType;
}

/**
 * Safely widen a `GraphQLScalarType` to `GraphQLInputType`.
 *
 * GraphQLScalarType satisfies GraphQLInputType at runtime, but TypeScript's
 * structural check sometimes fails for the generic parameterised variant.
 */
export function asInputType(scalar: GraphQLScalarType<unknown, unknown>): import('graphql').GraphQLInputType {
  return scalar as import('graphql').GraphQLInputType;
}

/**
 * Safely widen a `GraphQLScalarType` to `GraphQLOutputType`.
 *
 * GraphQLScalarType satisfies GraphQLOutputType at runtime, but TypeScript's
 * structural check sometimes fails for the generic parameterised variant.
 */
export function asOutputType(scalar: GraphQLScalarType<unknown, unknown>): import('graphql').GraphQLOutputType {
  return scalar as import('graphql').GraphQLOutputType;
}

// ─── UUID ────────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUUID(value: unknown): string {
  const str = String(value);
  if (!UUID_REGEX.test(str)) {
    throw new TypeError(`Invalid Uuid: "${str}"`);
  }
  return str;
}

export const GraphQLUuid = new GraphQLScalarType({
  name: 'Uuid',
  description: 'A UUID scalar type conforming to RFC 4122.',

  serialize: validateUUID as GraphQLScalarSerializer<string>,
  parseValue: validateUUID as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Uuid must be a string, got: ${ast.kind}`);
    }
    return validateUUID(ast.value);
  },
});

// ─── Timestamptz ─────────────────────────────────────────────────────────────

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function validateDateTime(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const str = String(value);
  if (!ISO_DATETIME_REGEX.test(str)) {
    throw new TypeError(`Invalid Timestamptz: "${str}". Expected ISO 8601 format.`);
  }
  return str;
}

export const GraphQLTimestamptz = new GraphQLScalarType({
  name: 'Timestamptz',
  description: 'An ISO 8601 datetime with timezone.',

  serialize: validateDateTime as GraphQLScalarSerializer<string>,
  parseValue: validateDateTime as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Timestamptz must be a string, got: ${ast.kind}`);
    }
    return validateDateTime(ast.value);
  },
});

// ─── Timestamp (without timezone) ────────────────────────────────────────────

const ISO_DATETIME_NO_TZ_REGEX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

function validateTimestamp(value: unknown): string {
  if (value instanceof Date) {
    // Strip timezone info — return local representation
    return value.toISOString().replace('Z', '');
  }
  const str = String(value);
  if (!ISO_DATETIME_NO_TZ_REGEX.test(str) && !ISO_DATETIME_REGEX.test(str)) {
    throw new TypeError(`Invalid Timestamp: "${str}". Expected ISO 8601 datetime format (without timezone).`);
  }
  return str;
}

export const GraphQLTimestamp = new GraphQLScalarType({
  name: 'Timestamp',
  description: 'An ISO 8601 datetime without timezone.',

  serialize: validateTimestamp as GraphQLScalarSerializer<string>,
  parseValue: validateTimestamp as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Timestamp must be a string, got: ${ast.kind}`);
    }
    return validateTimestamp(ast.value);
  },
});

// ─── Date ────────────────────────────────────────────────────────────────────

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(value: unknown): string {
  const str = String(value);
  if (!ISO_DATE_REGEX.test(str)) {
    throw new TypeError(`Invalid Date: "${str}". Expected YYYY-MM-DD format.`);
  }
  return str;
}

export const GraphQLDate = new GraphQLScalarType({
  name: 'Date',
  description: 'An ISO 8601 date scalar (YYYY-MM-DD).',

  serialize: validateDate as GraphQLScalarSerializer<string>,
  parseValue: validateDate as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Date must be a string, got: ${ast.kind}`);
    }
    return validateDate(ast.value);
  },
});

// ─── Time ────────────────────────────────────────────────────────────────────

const ISO_TIME_REGEX = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function validateTime(value: unknown): string {
  const str = String(value);
  if (!ISO_TIME_REGEX.test(str)) {
    throw new TypeError(`Invalid Time: "${str}". Expected HH:MM:SS format.`);
  }
  return str;
}

export const GraphQLTime = new GraphQLScalarType({
  name: 'Time',
  description: 'An ISO 8601 time scalar (HH:MM:SS).',

  serialize: validateTime as GraphQLScalarSerializer<string>,
  parseValue: validateTime as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Time must be a string, got: ${ast.kind}`);
    }
    return validateTime(ast.value);
  },
});

// ─── JSON / JSONB ────────────────────────────────────────────────────────────

function parseJSONLiteral(ast: { kind: string; value?: string; fields?: ReadonlyArray<{ name: { value: string }; value: { kind: string; value?: string } }> }): unknown {
  switch (ast.kind) {
    case Kind.STRING:
      return ast.value;
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      return parseInt(ast.value!, 10);
    case Kind.FLOAT:
      return parseFloat(ast.value!);
    case Kind.OBJECT:
      // eslint-disable-next-line no-case-declarations
      const obj: Record<string, unknown> = {};
      for (const field of (ast as unknown as { fields: ReadonlyArray<{ name: { value: string }; value: Parameters<typeof parseJSONLiteral>[0] }> }).fields) {
        obj[field.name.value] = parseJSONLiteral(field.value);
      }
      return obj;
    case Kind.LIST:
      return ((ast as unknown as { values: ReadonlyArray<Parameters<typeof parseJSONLiteral>[0]> }).values).map(parseJSONLiteral);
    case Kind.NULL:
      return null;
    default:
      return undefined;
  }
}

const serializeJSON: GraphQLScalarSerializer<unknown> = (value: unknown) => value;
const parseValueJSON: GraphQLScalarValueParser<unknown> = (value: unknown) => value;
const parseLiteralJSON: GraphQLScalarLiteralParser<unknown> = (ast) =>
  parseJSONLiteral(ast as unknown as Parameters<typeof parseJSONLiteral>[0]);

export const GraphQLJson = new GraphQLScalarType({
  name: 'json',
  description: 'Arbitrary JSON scalar. Accepts any valid JSON value.',
  serialize: serializeJSON,
  parseValue: parseValueJSON,
  parseLiteral: parseLiteralJSON,
});

export const GraphQLJsonb = new GraphQLScalarType({
  name: 'Jsonb',
  description: 'PostgreSQL JSONB scalar. Accepts any valid JSON value.',
  serialize: serializeJSON,
  parseValue: parseValueJSON,
  parseLiteral: parseLiteralJSON,
});

// ─── Smallint ─────────────────────────────────────────────────────────────────

function validateSmallint(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < -32768 || num > 32767) {
    throw new TypeError(`Invalid Smallint: "${value}". Must be an integer between -32768 and 32767.`);
  }
  return num;
}

export const GraphQLSmallint = new GraphQLScalarType({
  name: 'Smallint',
  description: 'A 16-bit signed integer (-32768 to 32767).',

  serialize: validateSmallint as GraphQLScalarSerializer<number>,
  parseValue: validateSmallint as GraphQLScalarValueParser<number>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.INT) {
      throw new TypeError(`Smallint must be an integer, got: ${ast.kind}`);
    }
    return validateSmallint((ast as { value: string }).value);
  },
});

// ─── BigInt ──────────────────────────────────────────────────────────────────

function validateBigInt(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  const str = String(value);
  // Validate it's a valid integer string (possibly negative)
  if (!/^-?\d+$/.test(str)) {
    throw new TypeError(`Invalid Bigint: "${str}". Must be an integer.`);
  }
  return str;
}

export const GraphQLBigint = new GraphQLScalarType({
  name: 'Bigint',
  description: 'A 64-bit integer, serialized as a string to avoid precision loss.',

  serialize: validateBigInt as GraphQLScalarSerializer<string>,
  parseValue: validateBigInt as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT) {
      throw new TypeError(`Bigint must be a string or integer, got: ${ast.kind}`);
    }
    return validateBigInt((ast as { value: string }).value);
  },
});

// ─── Numeric (numeric/money) ─────────────────────────────────────────────────

function validateNumeric(value: unknown): string {
  const str = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new TypeError(`Invalid Numeric: "${str}". Must be a numeric value.`);
  }
  return str;
}

export const GraphQLNumeric = new GraphQLScalarType({
  name: 'Numeric',
  description: 'An arbitrary precision decimal, serialized as a string.',

  serialize: validateNumeric as GraphQLScalarSerializer<string>,
  parseValue: validateNumeric as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT && ast.kind !== Kind.FLOAT) {
      throw new TypeError(`Numeric must be a string or number, got: ${ast.kind}`);
    }
    return validateNumeric((ast as { value: string }).value);
  },
});

// ─── Interval ────────────────────────────────────────────────────────────────

export const GraphQLInterval = new GraphQLScalarType({
  name: 'Interval',
  description: 'A PostgreSQL interval, serialized as a string (e.g. "1 year 2 months 3 days").',

  serialize(value: unknown): string {
    return String(value);
  },
  parseValue(value: unknown): string {
    return String(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Interval must be a string, got: ${ast.kind}`);
    }
    return ast.value;
  },
});

// ─── Bytea ───────────────────────────────────────────────────────────────────

export const GraphQLBytea = new GraphQLScalarType({
  name: 'Bytea',
  description: 'PostgreSQL bytea (binary data), serialized as a hex or base64 string.',

  serialize(value: unknown): string {
    if (Buffer.isBuffer(value)) {
      return (value as Buffer).toString('hex');
    }
    return String(value);
  },
  parseValue(value: unknown): string {
    return String(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Bytea must be a string, got: ${ast.kind}`);
    }
    return ast.value;
  },
});

// ─── Inet ────────────────────────────────────────────────────────────────────

export const GraphQLInet = new GraphQLScalarType({
  name: 'Inet',
  description: 'PostgreSQL inet/cidr — an IP address or network, serialized as a string.',

  serialize(value: unknown): string {
    return String(value);
  },
  parseValue(value: unknown): string {
    return String(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Inet must be a string, got: ${ast.kind}`);
    }
    return ast.value;
  },
});

// ─── Bpchar ─────────────────────────────────────────────────────────────────

export const GraphQLBpchar = new GraphQLScalarType({
  name: 'Bpchar',
  description: 'PostgreSQL blank-padded character type (char(n)).',

  serialize(value: unknown): string {
    return String(value);
  },
  parseValue(value: unknown): string {
    return String(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Bpchar must be a string, got: ${ast.kind}`);
    }
    return ast.value;
  },
});

// ─── PG Array Scalars ─────────────────────────────────────────────────────

/**
 * PostgreSQL array type scalars. These represent PG array types (e.g., text[])
 * that Hasura exposes as custom scalars in action SDL definitions.
 * Values are JSON arrays (e.g., ["a", "b", "c"]).
 */

function parseArrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON — wrap as single-element array
    }
  }
  return [value];
}

export const GraphQLTextArray = new GraphQLScalarType({
  name: '_text',
  description: 'PostgreSQL text[] array type, serialized as a JSON array of strings.',

  serialize: ((value: unknown) => parseArrayValue(value)) as GraphQLScalarSerializer<unknown[]>,
  parseValue: ((value: unknown) => parseArrayValue(value)) as GraphQLScalarValueParser<unknown[]>,
  parseLiteral(ast) {
    if (ast.kind === Kind.LIST) {
      return (ast as unknown as { values: ReadonlyArray<{ kind: string; value?: string }> }).values
        .map((v) => v.value ?? null);
    }
    if (ast.kind === Kind.STRING) {
      return parseArrayValue(ast.value);
    }
    throw new TypeError(`_text must be a list or JSON string, got: ${ast.kind}`);
  },
});

// ─── Scalar Registry ────────────────────────────────────────────────────────

/**
 * Map of all custom scalar types by name.
 * Used by the schema generator to register them.
 */
export const customScalars: Record<string, GraphQLScalarType> = {
  Uuid: GraphQLUuid,
  Timestamptz: GraphQLTimestamptz,
  Timestamp: GraphQLTimestamp,
  Date: GraphQLDate,
  Time: GraphQLTime,
  json: GraphQLJson,
  Jsonb: GraphQLJsonb,
  Smallint: GraphQLSmallint,
  Bigint: GraphQLBigint,
  Numeric: GraphQLNumeric,
  Interval: GraphQLInterval,
  Bytea: GraphQLBytea,
  Inet: GraphQLInet,
  Bpchar: GraphQLBpchar,
  _text: GraphQLTextArray,
};
