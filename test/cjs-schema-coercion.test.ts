/**
 * buildCjsSchema scalar coercion.
 *
 * buildCjsSchema rebuilds the schema from SDL and re-attaches scalar
 * behaviour by patching scalar instances. graphql 17 executes the
 * coerce* hooks captured at construction (serialize/parseValue/parseLiteral
 * are deprecated aliases), so patching only the legacy names silently
 * disables custom scalar validation and the Hasura-compat coercions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
} from 'graphql';
import { buildCjsSchema } from '../src/server/schema.js';
import { GraphQLUuid } from '../src/schema/scalars.js';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';

// Execute with the same graphql instance buildCjsSchema builds against.
const cjsGraphql = createRequire(import.meta.url)('graphql') as typeof import('graphql');

const esmSchema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      echoUuid: {
        type: GraphQLUuid,
        args: { id: { type: GraphQLUuid } },
        resolve: (_src, args: { id: string }) => args.id,
      },
      echoString: {
        type: GraphQLString,
        args: { s: { type: GraphQLString } },
        resolve: (_src, args: { s: unknown }) => `${typeof args.s}:${String(args.s)}`,
      },
      textCount: {
        type: GraphQLInt,
        resolve: () => '42',
      },
    },
  }),
});

function run(source: string, variableValues?: Record<string, unknown>) {
  return cjsGraphql.graphqlSync({ schema: buildCjsSchema(esmSchema), source, variableValues });
}

afterEach(() => configureStringifyNumericTypes(false));

describe('buildCjsSchema scalar coercion', () => {
  it('keeps custom scalar validation for variables', () => {
    const res = run('query($id: Uuid) { echoUuid(id: $id) }', { id: 'not-a-uuid' });
    expect(res.errors?.[0]?.message).toMatch(/uuid/i);
  });

  it('keeps custom scalar validation for literals', () => {
    const res = run('{ echoUuid(id: "not-a-uuid") }');
    expect(res.errors?.[0]?.message).toMatch(/uuid/i);
  });

  it('accepts a valid uuid', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const res = run('query($id: Uuid) { echoUuid(id: $id) }', { id });
    expect(res.errors).toBeUndefined();
    expect(res.data?.echoUuid).toBe(id);
  });

  it('coerces numeric literals and variables to String (Hasura compat)', () => {
    expect(run('{ echoString(s: 213) }').data?.echoString).toBe('string:213');
    const res = run('query($s: String) { echoString(s: $s) }', { s: 213 });
    expect(res.errors).toBeUndefined();
    expect(res.data?.echoString).toBe('string:213');
  });

  it('passes text-cast Int results through when stringify_numeric_types is on', () => {
    configureStringifyNumericTypes(true);
    expect(run('{ textCount }').data?.textCount).toBe('42');
    configureStringifyNumericTypes(false);
    expect(run('{ textCount }').data?.textCount).toBe(42);
  });
});
