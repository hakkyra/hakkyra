import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { resetCustomOutputTypeCache } from '../src/schema/custom-queries.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel } from '../src/types.js';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest,
  tokens,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  getPool,
} from './setup.js';

type AnyRow = Record<string, unknown>;

// ─── Database Migration ──────────────────────────────────────────────────────

/**
 * Ensure the array columns exist in the test database.
 * This is idempotent — safe to call even if columns already exist.
 */
async function ensureArrayColumns(): Promise<void> {
  const pool = getPool();
  await pool.query(`ALTER TABLE supplier ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}'`);
  await pool.query(`ALTER TABLE supplier ADD COLUMN IF NOT EXISTS ratings int[] DEFAULT '{}'`);
  await pool.query(`UPDATE supplier SET tags = '{premium,verified}', ratings = '{5,4,5}' WHERE code = 'TEST_SUP' AND (tags = '{}' OR tags IS NULL)`);
}

// ─── Schema-Level Tests ──────────────────────────────────────────────────────

describe('Array Comparison Types — Schema', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    resetComparisonTypeCache();
    resetCustomOutputTypeCache();
    await waitForDb();
    await ensureArrayColumns();
    const pool = getPool();
    const introspection = await introspectDatabase(pool);
    const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
    const result = mergeSchemaModel(introspection, config);
    schema = generateSchema(result.model);
  });

  afterAll(async () => {
    await closePool();
  });

  it('should generate StringArrayComparisonExp type', () => {
    const typeMap = schema.getTypeMap();
    const compType = typeMap['StringArrayComparisonExp'] as GraphQLInputObjectType | undefined;
    expect(compType).toBeDefined();
  });

  it('StringArrayComparisonExp should have correct fields', () => {
    const typeMap = schema.getTypeMap();
    const compType = typeMap['StringArrayComparisonExp'] as GraphQLInputObjectType;
    const fields = compType.getFields();
    const fieldNames = Object.keys(fields);

    // Must have all array comparison operators
    expect(fieldNames).toContain('_eq');
    expect(fieldNames).toContain('_neq');
    expect(fieldNames).toContain('_gt');
    expect(fieldNames).toContain('_gte');
    expect(fieldNames).toContain('_lt');
    expect(fieldNames).toContain('_lte');
    expect(fieldNames).toContain('_contains');
    expect(fieldNames).toContain('_containedIn');
    expect(fieldNames).toContain('_in');
    expect(fieldNames).toContain('_nin');
    expect(fieldNames).toContain('_isNull');
  });

  it('StringArrayComparisonExp _eq should be [String!]', () => {
    const typeMap = schema.getTypeMap();
    const compType = typeMap['StringArrayComparisonExp'] as GraphQLInputObjectType;
    const eqField = compType.getFields()['_eq'];
    // [String!] => GraphQLList(GraphQLNonNull(GraphQLString))
    expect(eqField.type).toBeInstanceOf(GraphQLList);
    const innerType = (eqField.type as GraphQLList<any>).ofType;
    expect(innerType).toBeInstanceOf(GraphQLNonNull);
  });

  it('StringArrayComparisonExp _in should be [[String!]!]', () => {
    const typeMap = schema.getTypeMap();
    const compType = typeMap['StringArrayComparisonExp'] as GraphQLInputObjectType;
    const inField = compType.getFields()['_in'];
    // [[String!]!] => GraphQLList(GraphQLNonNull(GraphQLList(GraphQLNonNull(String))))
    expect(inField.type).toBeInstanceOf(GraphQLList);
    const outerInner = (inField.type as GraphQLList<any>).ofType;
    expect(outerInner).toBeInstanceOf(GraphQLNonNull);
    const innerList = (outerInner as GraphQLNonNull<any>).ofType;
    expect(innerList).toBeInstanceOf(GraphQLList);
  });

  it('StringArrayComparisonExp _isNull should be Boolean', () => {
    const typeMap = schema.getTypeMap();
    const compType = typeMap['StringArrayComparisonExp'] as GraphQLInputObjectType;
    const isNullField = compType.getFields()['_isNull'];
    expect(isNullField).toBeDefined();
  });

  it('should generate IntArrayComparisonExp type', () => {
    const typeMap = schema.getTypeMap();
    const compType = typeMap['IntArrayComparisonExp'] as GraphQLInputObjectType | undefined;
    expect(compType).toBeDefined();
  });

  it('IntArrayComparisonExp should have correct fields', () => {
    const typeMap = schema.getTypeMap();
    const compType = typeMap['IntArrayComparisonExp'] as GraphQLInputObjectType;
    const fieldNames = Object.keys(compType.getFields());
    expect(fieldNames).toContain('_eq');
    expect(fieldNames).toContain('_neq');
    expect(fieldNames).toContain('_contains');
    expect(fieldNames).toContain('_containedIn');
    expect(fieldNames).toContain('_in');
    expect(fieldNames).toContain('_nin');
    expect(fieldNames).toContain('_isNull');
  });

  it('Supplier BoolExp should use StringArrayComparisonExp for tags', () => {
    const typeMap = schema.getTypeMap();
    const boolExpType = typeMap['SupplierBoolExp'] as GraphQLInputObjectType | undefined;
    expect(boolExpType).toBeDefined();
    const tagsField = boolExpType!.getFields()['tags'];
    expect(tagsField).toBeDefined();
    // The type should be StringArrayComparisonExp
    const fieldTypeName = (tagsField.type as GraphQLInputObjectType).name;
    expect(fieldTypeName).toBe('StringArrayComparisonExp');
  });

  it('Supplier BoolExp should use IntArrayComparisonExp for ratings', () => {
    const typeMap = schema.getTypeMap();
    const boolExpType = typeMap['SupplierBoolExp'] as GraphQLInputObjectType | undefined;
    expect(boolExpType).toBeDefined();
    const ratingsField = boolExpType!.getFields()['ratings'];
    expect(ratingsField).toBeDefined();
    const fieldTypeName = (ratingsField.type as GraphQLInputObjectType).name;
    expect(fieldTypeName).toBe('IntArrayComparisonExp');
  });

  it('Supplier object type should expose tags as [String!]', () => {
    const typeMap = schema.getTypeMap();
    const supplierType = typeMap['Supplier'] as GraphQLObjectType | undefined;
    expect(supplierType).toBeDefined();
    const tagsField = supplierType!.getFields()['tags'];
    expect(tagsField).toBeDefined();
    // Should be a list type [String!]
    expect(tagsField.type).toBeInstanceOf(GraphQLList);
  });

  it('Supplier object type should expose ratings as [Int!]', () => {
    const typeMap = schema.getTypeMap();
    const supplierType = typeMap['Supplier'] as GraphQLObjectType | undefined;
    expect(supplierType).toBeDefined();
    const ratingsField = supplierType!.getFields()['ratings'];
    expect(ratingsField).toBeDefined();
    expect(ratingsField.type).toBeInstanceOf(GraphQLList);
  });
});

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe('Array Comparison Types — E2E', () => {
  beforeAll(async () => {
    process.env['DATABASE_URL'] = TEST_DB_URL;
    process.env['HAKKYRA_ADMIN_SECRET'] = 'test-admin-secret-hakkyra';
    // Reset caches so startServer can generate a fresh schema
    resetComparisonTypeCache();
    resetCustomOutputTypeCache();
    await waitForDb();
    await ensureArrayColumns();
    await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer();
    await closePool();
  });

  it('should query supplier with array fields', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier { id name tags ratings } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]['tags']).toEqual(['premium', 'verified']);
    expect(suppliers[0]['ratings']).toEqual([5, 4, 5]);
  });

  it('should filter with _contains on text[] column', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _contains: ["premium"] } }) { id name tags } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]['name']).toBe('TestSupplier');
  });

  it('should filter with _contains returning no results for non-matching array', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _contains: ["nonexistent"] } }) { id name } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(0);
  });

  it('should filter with _containedIn on text[] column', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _containedIn: ["premium", "verified", "new"] } }) { id name } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(1);
  });

  it('should filter with _containedIn returning no results for too-narrow superset', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _containedIn: ["premium"] } }) { id name } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    // TestSupplier has ["premium", "verified"], which is NOT contained in ["premium"]
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(0);
  });

  it('should filter with _eq on text[] column (exact match)', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _eq: ["premium", "verified"] } }) { id name } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]['name']).toBe('TestSupplier');
  });

  it('should filter with _eq returning no results for non-matching array', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _eq: ["verified", "premium"] } }) { id name } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    // PG array equality is order-sensitive, so ["verified", "premium"] != ["premium", "verified"]
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(0);
  });

  it('should filter with _contains on int[] column', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { ratings: { _contains: [5] } }) { id name ratings } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(1);
  });

  it('should filter with _isNull on array column', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _isNull: false } }) { id name } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(1);
  });

  it('should insert supplier with array values', async () => {
    const token = await tokens.administrator();
    const { status, body } = await graphqlRequest(
      `mutation {
        insertSupplierOne(object: {
          name: "ArrayTestSupplier"
          code: "ARRAY_TEST"
          tags: ["bulk", "international"]
          ratings: [3, 4]
        }) {
          id name tags ratings
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const supplier = (body.data as { insertSupplierOne: AnyRow }).insertSupplierOne;
    expect(supplier['tags']).toEqual(['bulk', 'international']);
    expect(supplier['ratings']).toEqual([3, 4]);
  });

  it('should update supplier with array values', async () => {
    const token = await tokens.administrator();
    const { status, body } = await graphqlRequest(
      `mutation {
        updateSupplier(
          where: { code: { _eq: "ARRAY_TEST" } }
          _set: { tags: ["bulk", "international", "verified"] }
        ) {
          returning { id name tags }
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const returning = (body.data as { updateSupplier: { returning: AnyRow[] } }).updateSupplier.returning;
    expect(returning).toHaveLength(1);
    expect(returning[0]['tags']).toEqual(['bulk', 'international', 'verified']);
  });

  it('should filter the updated supplier with _contains', async () => {
    const token = await tokens.backoffice();
    const { status, body } = await graphqlRequest(
      `query { supplier(where: { tags: { _contains: ["international", "verified"] } }) { id name code } }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const suppliers = (body.data as { supplier: AnyRow[] }).supplier;
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]['code']).toBe('ARRAY_TEST');
  });

  it('should clean up test data', async () => {
    // Delete the test supplier we created
    const pool = getPool();
    await pool.query(`DELETE FROM supplier WHERE code = 'ARRAY_TEST'`);
  });
});
