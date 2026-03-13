/**
 * Custom GraphQL scalar types for PostgreSQL type mappings.
 *
 * Each scalar handles serialization (DB → client), parsing (client → DB),
 * and literal parsing (inline GraphQL values).
 */

import { GraphQLScalarType, Kind } from 'graphql';
import type { GraphQLScalarSerializer, GraphQLScalarValueParser, GraphQLScalarLiteralParser } from 'graphql';

// ─── UUID ────────────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUUID(value: unknown): string {
  const str = String(value);
  if (!UUID_REGEX.test(str)) {
    throw new TypeError(`Invalid UUID: "${str}"`);
  }
  return str;
}

export const GraphQLUUID = new GraphQLScalarType({
  name: 'UUID',
  description: 'A UUID scalar type conforming to RFC 4122.',

  serialize: validateUUID as GraphQLScalarSerializer<string>,
  parseValue: validateUUID as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`UUID must be a string, got: ${ast.kind}`);
    }
    return validateUUID(ast.value);
  },
});

// ─── DateTime / Timestamptz ──────────────────────────────────────────────────

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function validateDateTime(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const str = String(value);
  if (!ISO_DATETIME_REGEX.test(str)) {
    throw new TypeError(`Invalid DateTime: "${str}". Expected ISO 8601 format.`);
  }
  return str;
}

export const GraphQLDateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'An ISO 8601 datetime scalar (alias: timestamptz).',

  serialize: validateDateTime as GraphQLScalarSerializer<string>,
  parseValue: validateDateTime as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`DateTime must be a string, got: ${ast.kind}`);
    }
    return validateDateTime(ast.value);
  },
});

/** Alias — Hasura uses "timestamptz" in some contexts. */
export const GraphQLTimestamptz = new GraphQLScalarType({
  name: 'Timestamptz',
  description: 'An ISO 8601 datetime with timezone. Alias for DateTime.',

  serialize: validateDateTime as GraphQLScalarSerializer<string>,
  parseValue: validateDateTime as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) {
      throw new TypeError(`Timestamptz must be a string, got: ${ast.kind}`);
    }
    return validateDateTime(ast.value);
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

export const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON scalar. Accepts any valid JSON value.',
  serialize: serializeJSON,
  parseValue: parseValueJSON,
  parseLiteral: parseLiteralJSON,
});

export const GraphQLJSONB = new GraphQLScalarType({
  name: 'JSONB',
  description: 'PostgreSQL JSONB scalar. Accepts any valid JSON value.',
  serialize: serializeJSON,
  parseValue: parseValueJSON,
  parseLiteral: parseLiteralJSON,
});

// ─── BigInt ──────────────────────────────────────────────────────────────────

function validateBigInt(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  const str = String(value);
  // Validate it's a valid integer string (possibly negative)
  if (!/^-?\d+$/.test(str)) {
    throw new TypeError(`Invalid BigInt: "${str}". Must be an integer.`);
  }
  return str;
}

export const GraphQLBigInt = new GraphQLScalarType({
  name: 'BigInt',
  description: 'A 64-bit integer, serialized as a string to avoid precision loss.',

  serialize: validateBigInt as GraphQLScalarSerializer<string>,
  parseValue: validateBigInt as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT) {
      throw new TypeError(`BigInt must be a string or integer, got: ${ast.kind}`);
    }
    return validateBigInt((ast as { value: string }).value);
  },
});

// ─── BigDecimal (numeric/money) ──────────────────────────────────────────────

function validateBigDecimal(value: unknown): string {
  const str = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new TypeError(`Invalid BigDecimal: "${str}". Must be a numeric value.`);
  }
  return str;
}

export const GraphQLBigDecimal = new GraphQLScalarType({
  name: 'BigDecimal',
  description: 'An arbitrary precision decimal, serialized as a string.',

  serialize: validateBigDecimal as GraphQLScalarSerializer<string>,
  parseValue: validateBigDecimal as GraphQLScalarValueParser<string>,
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT && ast.kind !== Kind.FLOAT) {
      throw new TypeError(`BigDecimal must be a string or number, got: ${ast.kind}`);
    }
    return validateBigDecimal((ast as { value: string }).value);
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

// ─── Scalar Registry ────────────────────────────────────────────────────────

/**
 * Map of all custom scalar types by name.
 * Used by the schema generator to register them.
 */
export const customScalars: Record<string, GraphQLScalarType> = {
  UUID: GraphQLUUID,
  DateTime: GraphQLDateTime,
  Timestamptz: GraphQLTimestamptz,
  Date: GraphQLDate,
  Time: GraphQLTime,
  JSON: GraphQLJSON,
  JSONB: GraphQLJSONB,
  BigInt: GraphQLBigInt,
  BigDecimal: GraphQLBigDecimal,
  Interval: GraphQLInterval,
  Bytea: GraphQLBytea,
  Inet: GraphQLInet,
};
