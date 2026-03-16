/**
 * P12.4 — JSONB mutation operators for update mutations.
 *
 * Tests:
 * 1. Schema generation: 5 JSONB input types per table with jsonb columns
 * 2. Schema generation: JSONB args wired on update mutations
 * 3. Schema generation: tables without jsonb columns have no JSONB input types
 * 4. SQL compilation: _append, _prepend, _deleteAtPath, _deleteElem, _deleteKey
 * 5. E2E: JSONB operators work end-to-end through GraphQL
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema, GraphQLInputObjectType, GraphQLNonNull, GraphQLList, GraphQLString, GraphQLInt, GraphQLScalarType } from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { compileUpdateByPk, compileUpdate } from '../src/sql/update.js';
import type { SchemaModel, TableInfo } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  startServer, stopServer, graphqlRequest,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ADMIN_SECRET, ALICE_ID,
} from './setup.js';

let schemaModel: SchemaModel;
let schema: GraphQLSchema;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  resetComparisonTypeCache();
  schema = generateSchema(schemaModel);
});

afterAll(async () => {
  await closePool();
});

// ─── Helper: get named type, unwrapping NonNull/List wrappers ────────────────

function getNamedType(type: unknown): unknown {
  let t = type as { ofType?: unknown; name?: string };
  while (t && 'ofType' in t && t.ofType) {
    t = t.ofType as typeof t;
  }
  return t;
}

// ─── Schema Tests ────────────────────────────────────────────────────────────

describe('P12.4 — JSONB mutation operator schema types', () => {

  describe('tables WITH jsonb columns (client has tags + metadata)', () => {
    it('should generate ClientAppendInput with jsonb column fields typed as Jsonb', () => {
      const type = schema.getType('ClientAppendInput');
      expect(type).toBeDefined();
      expect(type).toBeInstanceOf(GraphQLInputObjectType);
      const fields = (type as GraphQLInputObjectType).getFields();
      // client table has "tags" and "metadata" as jsonb columns
      expect(fields['tags']).toBeDefined();
      expect(fields['metadata']).toBeDefined();
      // Both should be Jsonb scalar type
      const tagsType = getNamedType(fields['tags'].type);
      expect((tagsType as GraphQLScalarType).name).toBe('Jsonb');
      const metadataType = getNamedType(fields['metadata'].type);
      expect((metadataType as GraphQLScalarType).name).toBe('Jsonb');
    });

    it('should generate ClientPrependInput with jsonb column fields typed as Jsonb', () => {
      const type = schema.getType('ClientPrependInput');
      expect(type).toBeDefined();
      expect(type).toBeInstanceOf(GraphQLInputObjectType);
      const fields = (type as GraphQLInputObjectType).getFields();
      expect(fields['tags']).toBeDefined();
      expect(fields['metadata']).toBeDefined();
    });

    it('should generate ClientDeleteAtPathInput with jsonb column fields typed as [String!]', () => {
      const type = schema.getType('ClientDeleteAtPathInput');
      expect(type).toBeDefined();
      expect(type).toBeInstanceOf(GraphQLInputObjectType);
      const fields = (type as GraphQLInputObjectType).getFields();
      expect(fields['tags']).toBeDefined();
      // Type should be [String!] — GraphQLList(GraphQLNonNull(GraphQLString))
      const tagsType = fields['tags'].type;
      expect(tagsType).toBeInstanceOf(GraphQLList);
      const inner = (tagsType as GraphQLList<GraphQLNonNull<typeof GraphQLString>>).ofType;
      expect(inner).toBeInstanceOf(GraphQLNonNull);
    });

    it('should generate ClientDeleteElemInput with jsonb column fields typed as Int', () => {
      const type = schema.getType('ClientDeleteElemInput');
      expect(type).toBeDefined();
      expect(type).toBeInstanceOf(GraphQLInputObjectType);
      const fields = (type as GraphQLInputObjectType).getFields();
      expect(fields['tags']).toBeDefined();
      expect(fields['tags'].type).toBe(GraphQLInt);
    });

    it('should generate ClientDeleteKeyInput with jsonb column fields typed as String', () => {
      const type = schema.getType('ClientDeleteKeyInput');
      expect(type).toBeDefined();
      expect(type).toBeInstanceOf(GraphQLInputObjectType);
      const fields = (type as GraphQLInputObjectType).getFields();
      expect(fields['metadata']).toBeDefined();
      expect(fields['metadata'].type).toBe(GraphQLString);
    });
  });

  describe('JSONB input types on other tables with jsonb columns', () => {
    it('should generate ProductAppendInput (product has tags + metadata)', () => {
      const type = schema.getType('ProductAppendInput');
      expect(type).toBeDefined();
      expect(type).toBeInstanceOf(GraphQLInputObjectType);
      const fields = (type as GraphQLInputObjectType).getFields();
      expect(fields['tags']).toBeDefined();
      expect(fields['metadata']).toBeDefined();
    });

    it('should generate InvoiceAppendInput (invoice has metadata)', () => {
      const type = schema.getType('InvoiceAppendInput');
      expect(type).toBeDefined();
      expect(type).toBeInstanceOf(GraphQLInputObjectType);
      const fields = (type as GraphQLInputObjectType).getFields();
      expect(fields['metadata']).toBeDefined();
    });
  });

  describe('JSONB args wired on update mutations', () => {
    it('should have _append, _prepend, _deleteAtPath, _deleteElem, _deleteKey on updateClients', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      // client table has custom root field "updateClients" (plural)
      const updateField = fields['updateClients'];
      expect(updateField).toBeDefined();
      const argNames = updateField.args.map(a => a.name);
      expect(argNames).toContain('_append');
      expect(argNames).toContain('_prepend');
      expect(argNames).toContain('_deleteAtPath');
      expect(argNames).toContain('_deleteElem');
      expect(argNames).toContain('_deleteKey');
    });

    it('should have JSONB args on updateClientByPk', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      const updateByPkField = fields['updateClientByPk'];
      expect(updateByPkField).toBeDefined();
      const argNames = updateByPkField.args.map(a => a.name);
      expect(argNames).toContain('_append');
      expect(argNames).toContain('_prepend');
      expect(argNames).toContain('_deleteAtPath');
      expect(argNames).toContain('_deleteElem');
      expect(argNames).toContain('_deleteKey');
    });
  });

  describe('tables WITHOUT jsonb columns should NOT have JSONB input types', () => {
    it('should not generate CurrencyAppendInput (currency has no jsonb columns)', () => {
      const type = schema.getType('CurrencyAppendInput');
      expect(type).toBeUndefined();
    });

    it('should not have _append arg on updateCurrency', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      const updateField = fields['updateCurrency'];
      if (updateField) {
        const argNames = updateField.args.map(a => a.name);
        expect(argNames).not.toContain('_append');
        expect(argNames).not.toContain('_prepend');
        expect(argNames).not.toContain('_deleteAtPath');
        expect(argNames).not.toContain('_deleteElem');
        expect(argNames).not.toContain('_deleteKey');
      }
    });
  });
});

// ─── SQL Compilation Tests ───────────────────────────────────────────────────

describe('P12.4 — JSONB mutation operator SQL compilation', () => {
  const adminSession = makeSession('admin');

  it('_append generates column = column || $N::jsonb', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: {},
      jsonbOps: { _append: { tags: ['new-tag'] } },
      returningColumns: ['id', 'tags'],
      session: adminSession,
    });
    expect(compiled.sql).toContain('||');
    expect(compiled.sql).toContain('::jsonb');
    // The param should be the JSON-stringified value
    expect(compiled.params).toContainEqual(JSON.stringify(['new-tag']));
  });

  it('_prepend generates column = $N::jsonb || column', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: {},
      jsonbOps: { _prepend: { tags: ['first-tag'] } },
      returningColumns: ['id', 'tags'],
      session: adminSession,
    });
    // Should have $N::jsonb || "tags" (prepend order)
    expect(compiled.sql).toMatch(/\$\d+::jsonb \|\| "tags"/);
  });

  it('_deleteAtPath generates column = column #- $N::text[]', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: {},
      jsonbOps: { _deleteAtPath: { metadata: ['nested', 'key'] } },
      returningColumns: ['id', 'metadata'],
      session: adminSession,
    });
    expect(compiled.sql).toContain('#-');
    expect(compiled.sql).toContain('::text[]');
  });

  it('_deleteElem generates column = column - $N (integer)', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: {},
      jsonbOps: { _deleteElem: { tags: 0 } },
      returningColumns: ['id', 'tags'],
      session: adminSession,
    });
    // "tags" = "tags" - $N::int
    expect(compiled.sql).toMatch(/"tags" = "tags" - \$\d+::int/);
    expect(compiled.params).toContain(0);
  });

  it('_deleteKey generates column = column - $N (text)', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: {},
      jsonbOps: { _deleteKey: { metadata: 'unwanted_key' } },
      returningColumns: ['id', 'metadata'],
      session: adminSession,
    });
    // "metadata" = "metadata" - $N
    expect(compiled.sql).toMatch(/"metadata" = "metadata" - \$\d+/);
    expect(compiled.params).toContain('unwanted_key');
  });

  it('_set takes precedence over JSONB operators for the same column', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: { tags: ['overridden'] },
      jsonbOps: { _append: { tags: ['appended'] } },
      returningColumns: ['id', 'tags'],
      session: adminSession,
    });
    // Should only have one assignment for tags (the _set one), not the _append one
    // Should NOT contain "||" for tags
    expect(compiled.sql).not.toContain('||');
  });

  it('compileUpdate with JSONB operators (bulk update)', () => {
    const table = findTable('client');
    const compiled = compileUpdate({
      table,
      where: { status: { _eq: 'active' } },
      _set: {},
      jsonbOps: { _append: { metadata: { updated: true } } },
      returningColumns: ['id', 'metadata'],
      session: adminSession,
    });
    expect(compiled.sql).toContain('||');
    expect(compiled.sql).toContain('::jsonb');
    expect(compiled.sql).toContain('WHERE');
  });

  it('multiple JSONB operators on different columns', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: {},
      jsonbOps: {
        _append: { tags: ['new-tag'] },
        _deleteKey: { metadata: 'old_key' },
      },
      returningColumns: ['id', 'tags', 'metadata'],
      session: adminSession,
    });
    // Should have || for tags append
    expect(compiled.sql).toContain('||');
    // Should have - for metadata deleteKey
    expect(compiled.sql).toMatch(/"metadata" = "metadata" - \$\d+/);
  });

  it('ignores JSONB operators on non-jsonb columns', () => {
    const table = findTable('client');
    const compiled = compileUpdateByPk({
      table,
      pkValues: { id: ALICE_ID },
      _set: { username: 'test' },
      jsonbOps: { _append: { username: 'ignored' } },
      returningColumns: ['id', 'username'],
      session: adminSession,
    });
    // Should only have the _set assignment for username, no ||
    expect(compiled.sql).not.toContain('||');
  });
});

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe('P12.4 — JSONB mutation operator E2E', () => {
  beforeAll(async () => {
    resetComparisonTypeCache();
    await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer();
  });

  it('_append appends to a jsonb array via updateByPk', async () => {
    const pool = getPool();

    // First, set a known base value
    await pool.query(`UPDATE client SET tags = '["existing"]'::jsonb WHERE id = $1`, [ALICE_ID]);

    const { status, body } = await graphqlRequest(
      `mutation($id: Uuid!, $append: ClientAppendInput) {
        updateClientByPk(pkColumns: { id: $id }, _set: {}, _append: $append) {
          id
          tags
        }
      }`,
      { id: ALICE_ID, append: { tags: ['new-tag'] } },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const result = body.data as { updateClientByPk: { id: string; tags: unknown } };
    expect(result.updateClientByPk).toBeDefined();
    // After append: ["existing"] || ["new-tag"] = ["existing", "new-tag"]
    const tags = result.updateClientByPk.tags;
    expect(tags).toEqual(['existing', 'new-tag']);
  });

  it('_prepend prepends to a jsonb array via updateByPk', async () => {
    const pool = getPool();
    await pool.query(`UPDATE client SET tags = '["existing"]'::jsonb WHERE id = $1`, [ALICE_ID]);

    const { status, body } = await graphqlRequest(
      `mutation($id: Uuid!, $prepend: ClientPrependInput) {
        updateClientByPk(pkColumns: { id: $id }, _set: {}, _prepend: $prepend) {
          id
          tags
        }
      }`,
      { id: ALICE_ID, prepend: { tags: ['first'] } },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const result = body.data as { updateClientByPk: { id: string; tags: unknown } };
    // After prepend: ["first"] || ["existing"] = ["first", "existing"]
    const tags = result.updateClientByPk.tags;
    expect(tags).toEqual(['first', 'existing']);
  });

  it('_deleteKey removes a top-level key from jsonb object via updateByPk', async () => {
    const pool = getPool();
    await pool.query(
      `UPDATE client SET metadata = '{"keep": 1, "remove": 2}'::jsonb WHERE id = $1`,
      [ALICE_ID],
    );

    const { status, body } = await graphqlRequest(
      `mutation($id: Uuid!, $deleteKey: ClientDeleteKeyInput) {
        updateClientByPk(pkColumns: { id: $id }, _set: {}, _deleteKey: $deleteKey) {
          id
          metadata
        }
      }`,
      { id: ALICE_ID, deleteKey: { metadata: 'remove' } },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const result = body.data as { updateClientByPk: { id: string; metadata: unknown } };
    expect(result.updateClientByPk.metadata).toEqual({ keep: 1 });
  });

  it('_deleteElem removes array element by index via updateByPk', async () => {
    const pool = getPool();
    await pool.query(
      `UPDATE client SET tags = '["a", "b", "c"]'::jsonb WHERE id = $1`,
      [ALICE_ID],
    );

    const { status, body } = await graphqlRequest(
      `mutation($id: Uuid!, $deleteElem: ClientDeleteElemInput) {
        updateClientByPk(pkColumns: { id: $id }, _set: {}, _deleteElem: $deleteElem) {
          id
          tags
        }
      }`,
      { id: ALICE_ID, deleteElem: { tags: 1 } },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const result = body.data as { updateClientByPk: { id: string; tags: unknown } };
    // After deleting index 1: ["a", "c"]
    expect(result.updateClientByPk.tags).toEqual(['a', 'c']);
  });

  it('_deleteAtPath removes value at nested path via updateByPk', async () => {
    const pool = getPool();
    await pool.query(
      `UPDATE client SET metadata = '{"a": {"b": {"c": 1}, "d": 2}}'::jsonb WHERE id = $1`,
      [ALICE_ID],
    );

    const { status, body } = await graphqlRequest(
      `mutation($id: Uuid!, $deleteAtPath: ClientDeleteAtPathInput) {
        updateClientByPk(pkColumns: { id: $id }, _set: {}, _deleteAtPath: $deleteAtPath) {
          id
          metadata
        }
      }`,
      { id: ALICE_ID, deleteAtPath: { metadata: ['a', 'b'] } },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const result = body.data as { updateClientByPk: { id: string; metadata: unknown } };
    // After deleting path ["a", "b"]: {"a": {"d": 2}}
    expect(result.updateClientByPk.metadata).toEqual({ a: { d: 2 } });
  });

  it('_append works with bulk update (updateClients)', async () => {
    const pool = getPool();
    await pool.query(`UPDATE client SET tags = '[]'::jsonb WHERE id = $1`, [ALICE_ID]);

    const { status, body } = await graphqlRequest(
      `mutation($where: ClientBoolExp!, $append: ClientAppendInput) {
        updateClients(where: $where, _append: $append) {
          affectedRows
          returning {
            id
            tags
          }
        }
      }`,
      {
        where: { id: { _eq: ALICE_ID } },
        append: { tags: ['bulk-appended'] },
      },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const result = body.data as { updateClients: { affectedRows: number; returning: Array<{ id: string; tags: unknown }> } };
    expect(result.updateClients.affectedRows).toBe(1);
    expect(result.updateClients.returning[0].tags).toEqual(['bulk-appended']);
  });

  it('JSONB operators work without _set (only JSONB op)', async () => {
    const pool = getPool();
    await pool.query(
      `UPDATE client SET metadata = '{"key": "value"}'::jsonb WHERE id = $1`,
      [ALICE_ID],
    );

    const { status, body } = await graphqlRequest(
      `mutation($id: Uuid!, $append: ClientAppendInput) {
        updateClientByPk(pkColumns: { id: $id }, _set: {}, _append: $append) {
          id
          metadata
        }
      }`,
      {
        id: ALICE_ID,
        append: { metadata: { extra: 'data' } },
      },
      { 'x-hasura-admin-secret': ADMIN_SECRET },
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const result = body.data as { updateClientByPk: { id: string; metadata: unknown } };
    // Object append: {"key": "value"} || {"extra": "data"} = {"key": "value", "extra": "data"}
    expect(result.updateClientByPk.metadata).toEqual({ key: 'value', extra: 'data' });
  });

  // Clean up test data
  afterAll(async () => {
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE client SET tags = '[]'::jsonb, metadata = '{}'::jsonb WHERE id = $1`,
        [ALICE_ID],
      );
    } catch { /* ignore cleanup errors */ }
  });
});
