/**
 * P12.3 — *Updates types for updateMany mutations.
 *
 * Verifies:
 * 1. Type is named {Table}Updates (not UpdateManyInput)
 * 2. Has required `where` field (BoolExp)
 * 3. Has optional `_set` field (SetInput)
 * 4. Has optional `_inc` field when table has numeric columns
 * 5. Has optional JSONB operator fields when table has jsonb columns
 * 6. Tables without jsonb/numeric columns get only where + _set
 * 7. The updateMany mutation arg type references Updates
 * 8. Resolver extracts JSONB ops from update entries
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLList,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { compileUpdateMany } from '../src/sql/update.js';
import type { SchemaModel, TableInfo, BoolExp } from '../src/types.js';
import {
  getPool,
  closePool,
  waitForDb,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  TEST_DB_URL,
  ALICE_ID,
} from './setup.js';

let schemaModel: SchemaModel;
let schema: GraphQLSchema;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

function makeSession(role: string) {
  return {
    role,
    'x-hasura-role': role,
    isAdmin: role === 'admin',
  } as any;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  await resolveTableEnums(schemaModel, pool);
  resetComparisonTypeCache();
  schema = generateSchema(schemaModel, {
    actions: config.actions,
    actionsGraphql: config.actionsGraphql,
  });
});

afterAll(async () => {
  await closePool();
});

// ─── Schema Type Name Tests ───────────────────────────────────────────────────

describe('P12.3 — Updates type naming', () => {
  it('should generate ClientUpdates (not ClientUpdateManyInput)', () => {
    const typeMap = schema.getTypeMap();
    expect(typeMap['ClientUpdates']).toBeDefined();
    expect(typeMap['ClientUpdates']).toBeInstanceOf(GraphQLInputObjectType);
    // Old name should NOT exist
    expect(typeMap['ClientUpdateManyInput']).toBeUndefined();
  });

  it('should generate AccountUpdates', () => {
    const typeMap = schema.getTypeMap();
    expect(typeMap['AccountUpdates']).toBeDefined();
    expect(typeMap['AccountUpdates']).toBeInstanceOf(GraphQLInputObjectType);
    expect(typeMap['AccountUpdateManyInput']).toBeUndefined();
  });

  it('should generate ProductUpdates', () => {
    const typeMap = schema.getTypeMap();
    expect(typeMap['ProductUpdates']).toBeDefined();
    expect(typeMap['ProductUpdates']).toBeInstanceOf(GraphQLInputObjectType);
    expect(typeMap['ProductUpdateManyInput']).toBeUndefined();
  });

  it('should generate CurrencyUpdates', () => {
    const typeMap = schema.getTypeMap();
    expect(typeMap['CurrencyUpdates']).toBeDefined();
    expect(typeMap['CurrencyUpdates']).toBeInstanceOf(GraphQLInputObjectType);
    expect(typeMap['CurrencyUpdateManyInput']).toBeUndefined();
  });
});

// ─── Updates Type Fields ──────────────────────────────────────────────────────

describe('P12.3 — Updates type fields', () => {
  describe('ClientUpdates (has numeric + jsonb columns)', () => {
    it('should have required where field', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['where']).toBeDefined();
      expect(fields['where'].type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have optional _set field', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['_set']).toBeDefined();
      expect(fields['_set'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have optional _inc field (trust_level is numeric)', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['_inc']).toBeDefined();
      expect(fields['_inc'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have optional _append field (tags and metadata are jsonb)', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['_append']).toBeDefined();
      expect(fields['_append'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have optional _prepend field', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['_prepend']).toBeDefined();
      expect(fields['_prepend'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have optional _deleteAtPath field', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['_deleteAtPath']).toBeDefined();
      expect(fields['_deleteAtPath'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have optional _deleteElem field', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['_deleteElem']).toBeDefined();
      expect(fields['_deleteElem'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have optional _deleteKey field', () => {
      const type = schema.getType('ClientUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      expect(fields['_deleteKey']).toBeDefined();
      expect(fields['_deleteKey'].type).not.toBeInstanceOf(GraphQLNonNull);
    });
  });

  describe('CurrencyUpdates (no numeric, no jsonb columns)', () => {
    it('should have where and _set fields only', () => {
      const type = schema.getType('CurrencyUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      const fieldNames = Object.keys(fields);

      expect(fieldNames).toContain('where');
      expect(fieldNames).toContain('_set');

      // decimal_places is INT so _inc should be present
      expect(fieldNames).toContain('_inc');

      // No jsonb columns => no JSONB operator fields
      expect(fieldNames).not.toContain('_append');
      expect(fieldNames).not.toContain('_prepend');
      expect(fieldNames).not.toContain('_deleteAtPath');
      expect(fieldNames).not.toContain('_deleteElem');
      expect(fieldNames).not.toContain('_deleteKey');
    });
  });

  describe('CountryUpdates (no numeric, no jsonb columns)', () => {
    it('should have where and _set but no _inc or JSONB fields', () => {
      const type = schema.getType('CountryUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      const fieldNames = Object.keys(fields);

      expect(fieldNames).toContain('where');
      expect(fieldNames).toContain('_set');

      // Country has only id (text PK) and name (text) — no numeric, no jsonb
      expect(fieldNames).not.toContain('_inc');
      expect(fieldNames).not.toContain('_append');
      expect(fieldNames).not.toContain('_prepend');
      expect(fieldNames).not.toContain('_deleteAtPath');
      expect(fieldNames).not.toContain('_deleteElem');
      expect(fieldNames).not.toContain('_deleteKey');
    });
  });

  describe('AccountUpdates (numeric columns, no jsonb)', () => {
    it('should have _inc but no JSONB operator fields', () => {
      const type = schema.getType('AccountUpdates') as GraphQLInputObjectType;
      const fields = type.getFields();
      const fieldNames = Object.keys(fields);

      expect(fieldNames).toContain('where');
      expect(fieldNames).toContain('_set');
      expect(fieldNames).toContain('_inc');

      // Account has no jsonb columns
      expect(fieldNames).not.toContain('_append');
      expect(fieldNames).not.toContain('_prepend');
      expect(fieldNames).not.toContain('_deleteAtPath');
      expect(fieldNames).not.toContain('_deleteElem');
      expect(fieldNames).not.toContain('_deleteKey');
    });
  });
});

// ─── Mutation Arg Type Tests ──────────────────────────────────────────────────

describe('P12.3 — updateMany mutation uses Updates type', () => {
  it('updateClientMany should accept updates: [ClientUpdates!]!', () => {
    const mutationType = schema.getMutationType()!;
    const field = mutationType.getFields()['updateClientMany'];
    expect(field).toBeDefined();

    const updatesArg = field.args.find((a) => a.name === 'updates');
    expect(updatesArg).toBeDefined();

    // Type should be [ClientUpdates!]! — NonNull > List > NonNull > ClientUpdates
    const nonNullOuter = updatesArg!.type as GraphQLNonNull<any>;
    expect(nonNullOuter).toBeInstanceOf(GraphQLNonNull);

    const listType = nonNullOuter.ofType as GraphQLList<any>;
    expect(listType).toBeInstanceOf(GraphQLList);

    const nonNullInner = listType.ofType as GraphQLNonNull<any>;
    expect(nonNullInner).toBeInstanceOf(GraphQLNonNull);

    const inputType = nonNullInner.ofType as GraphQLInputObjectType;
    expect(inputType).toBeInstanceOf(GraphQLInputObjectType);
    expect(inputType.name).toBe('ClientUpdates');
  });
});

// ─── SQL Compiler Tests (JSONB ops in updateMany) ─────────────────────────────

describe('P12.3 — compileUpdateMany with JSONB operators', () => {
  const adminSession = makeSession('admin');

  it('should compile an update entry with _append JSONB op', () => {
    const table = findTable('client');
    const queries = compileUpdateMany({
      table,
      updates: [{
        where: { id: { _eq: ALICE_ID } } as BoolExp,
        _set: {},
        jsonbOps: {
          _append: { tags: ['new-tag'] },
        },
      }],
      returningColumns: ['id', 'tags'],
      session: adminSession,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('"tags" = "tags" ||');
    expect(queries[0].sql).toContain('::jsonb');
  });

  it('should compile multiple update entries with different operators', () => {
    const table = findTable('client');
    const queries = compileUpdateMany({
      table,
      updates: [
        {
          where: { id: { _eq: ALICE_ID } } as BoolExp,
          _set: { username: 'alice-updated' },
        },
        {
          where: { id: { _eq: ALICE_ID } } as BoolExp,
          _set: {},
          _inc: { trust_level: 1 },
          jsonbOps: {
            _append: { tags: ['vip'] },
          },
        },
      ],
      returningColumns: ['id', 'username', 'trust_level', 'tags'],
      session: adminSession,
    });

    expect(queries).toHaveLength(2);
    // First entry: _set only
    expect(queries[0].sql).toContain('"username" = $');
    // Second entry: _inc and _append
    expect(queries[1].sql).toContain('"trust_level" = "trust_level" + $');
    expect(queries[1].sql).toContain('"tags" = "tags" ||');
  });

  it('should compile _deleteKey in an update entry', () => {
    const table = findTable('client');
    const queries = compileUpdateMany({
      table,
      updates: [{
        where: { id: { _eq: ALICE_ID } } as BoolExp,
        _set: {},
        jsonbOps: {
          _deleteKey: { metadata: 'someKey' },
        },
      }],
      returningColumns: ['id', 'metadata'],
      session: adminSession,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('"metadata" = "metadata" - $');
  });
});

// ─── E2E: Execute update_many with JSONB ops against real DB ──────────────────

describe('P12.3 — updateMany E2E with JSONB operators', () => {
  const adminSession = makeSession('admin');

  it('should update client tags via _append in updateMany', async () => {
    const pool = getPool();
    const table = findTable('client');

    // Reset tags to known state
    await pool.query(`UPDATE client SET tags = '["existing"]'::jsonb WHERE id = $1`, [ALICE_ID]);

    // Compile updateMany with _append
    const queries = compileUpdateMany({
      table,
      updates: [{
        where: { id: { _eq: ALICE_ID } } as BoolExp,
        _set: {},
        jsonbOps: {
          _append: { tags: ['new-item'] },
        },
      }],
      returningColumns: ['id', 'tags'],
      session: adminSession,
    });

    expect(queries).toHaveLength(1);
    await pool.query(queries[0].sql, queries[0].params);

    // Verify the append happened
    const after = await pool.query('SELECT tags FROM client WHERE id = $1', [ALICE_ID]);
    const tags = after.rows[0].tags;
    // _append: column = column || value  =>  ["existing"] || ["new-item"] => ["existing", "new-item"]
    expect(tags).toEqual(['existing', 'new-item']);

    // Reset
    await pool.query(`UPDATE client SET tags = '[]'::jsonb WHERE id = $1`, [ALICE_ID]);
  });

  it('should update client via _inc and _deleteKey in the same updateMany entry', async () => {
    const pool = getPool();
    const table = findTable('client');

    // Set known state
    await pool.query(
      `UPDATE client SET trust_level = 5, metadata = '{"keep": 1, "remove": 2}'::jsonb WHERE id = $1`,
      [ALICE_ID],
    );

    // Compile updateMany with _inc + _deleteKey
    const queries = compileUpdateMany({
      table,
      updates: [{
        where: { id: { _eq: ALICE_ID } } as BoolExp,
        _set: {},
        _inc: { trust_level: 3 },
        jsonbOps: {
          _deleteKey: { metadata: 'remove' },
        },
      }],
      returningColumns: ['id', 'trust_level', 'metadata'],
      session: adminSession,
    });

    expect(queries).toHaveLength(1);
    await pool.query(queries[0].sql, queries[0].params);

    // Verify
    const after = await pool.query('SELECT trust_level, metadata FROM client WHERE id = $1', [ALICE_ID]);
    expect(after.rows[0].trust_level).toBe(8); // 5 + 3
    expect(after.rows[0].metadata).toEqual({ keep: 1 }); // 'remove' key deleted

    // Reset
    await pool.query(
      `UPDATE client SET trust_level = 0, metadata = '{}'::jsonb WHERE id = $1`,
      [ALICE_ID],
    );
  });
});
