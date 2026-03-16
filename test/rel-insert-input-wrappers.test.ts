/**
 * Tests for P12.1 — ObjRelInsertInput and ArrRelInsertInput wrapper types.
 *
 * Verifies:
 * - {Table}ObjRelInsertInput types exist with data + optional onConflict fields
 * - {Table}ArrRelInsertInput types exist with data[] + optional onConflict fields
 * - InsertInput relationship fields reference wrapper types (not raw InsertInput)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLList,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import type { SchemaModel, HakkyraConfig } from '../src/types.js';
import {
  getPool, closePool, waitForDb,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
} from './setup.js';

let schema: GraphQLSchema;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  resetComparisonTypeCache();

  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config: HakkyraConfig = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  const schemaModel: SchemaModel = result.model;
  await resolveTableEnums(schemaModel, pool);
  schema = generateSchema(schemaModel, {
    actions: config.actions,
    actionsGraphql: config.actionsGraphql,
  });
});

afterAll(async () => {
  await closePool();
});

// ── ObjRelInsertInput wrapper types ─────────────────────────────────────────

describe('P12.1 — ObjRelInsertInput wrapper types', () => {
  it('should generate {Table}ObjRelInsertInput types', () => {
    const typeMap = schema.getTypeMap();
    // Client table should have an ObjRelInsertInput wrapper
    expect(typeMap['ClientObjRelInsertInput']).toBeDefined();
    expect(typeMap['ClientObjRelInsertInput']).toBeInstanceOf(GraphQLInputObjectType);
  });

  it('ObjRelInsertInput should have data: {Table}InsertInput! (required)', () => {
    const objRelType = schema.getType('ClientObjRelInsertInput') as GraphQLInputObjectType;
    const fields = objRelType.getFields();

    expect(fields['data']).toBeDefined();
    // data should be non-null
    expect(fields['data'].type).toBeInstanceOf(GraphQLNonNull);
    // Inner type should be {Table}InsertInput
    const innerType = (fields['data'].type as GraphQLNonNull<any>).ofType;
    expect(innerType).toBeInstanceOf(GraphQLInputObjectType);
    expect(innerType.name).toBe('ClientInsertInput');
  });

  it('ObjRelInsertInput should have onConflict field when table has constraints', () => {
    const objRelType = schema.getType('ClientObjRelInsertInput') as GraphQLInputObjectType;
    const fields = objRelType.getFields();

    // Client table has PK + unique constraints, so onConflict should exist
    expect(fields['onConflict']).toBeDefined();
    const onConflictType = fields['onConflict'].type;
    // onConflict should be nullable (optional)
    expect(onConflictType).not.toBeInstanceOf(GraphQLNonNull);
    expect((onConflictType as GraphQLInputObjectType).name).toBe('ClientOnConflict');
  });

  it('should generate ObjRelInsertInput for multiple tables', () => {
    const typeMap = schema.getTypeMap();
    // Branch, Account, Invoice, etc. should all have wrapper types
    expect(typeMap['BranchObjRelInsertInput']).toBeDefined();
    expect(typeMap['AccountObjRelInsertInput']).toBeDefined();
    expect(typeMap['InvoiceObjRelInsertInput']).toBeDefined();
  });
});

// ── ArrRelInsertInput wrapper types ─────────────────────────────────────────

describe('P12.1 — ArrRelInsertInput wrapper types', () => {
  it('should generate {Table}ArrRelInsertInput types', () => {
    const typeMap = schema.getTypeMap();
    expect(typeMap['ClientArrRelInsertInput']).toBeDefined();
    expect(typeMap['ClientArrRelInsertInput']).toBeInstanceOf(GraphQLInputObjectType);
  });

  it('ArrRelInsertInput should have data: [{Table}InsertInput!]! (required array)', () => {
    const arrRelType = schema.getType('AccountArrRelInsertInput') as GraphQLInputObjectType;
    const fields = arrRelType.getFields();

    expect(fields['data']).toBeDefined();
    // data should be non-null
    expect(fields['data'].type).toBeInstanceOf(GraphQLNonNull);
    // Non-null wrapper around list
    const listType = (fields['data'].type as GraphQLNonNull<any>).ofType;
    expect(listType).toBeInstanceOf(GraphQLList);
    // List items should be non-null
    const itemType = (listType as GraphQLList<any>).ofType;
    expect(itemType).toBeInstanceOf(GraphQLNonNull);
    // Inner type should be {Table}InsertInput
    const innerType = (itemType as GraphQLNonNull<any>).ofType;
    expect(innerType).toBeInstanceOf(GraphQLInputObjectType);
    expect(innerType.name).toBe('AccountInsertInput');
  });

  it('ArrRelInsertInput should have onConflict field when table has constraints', () => {
    const arrRelType = schema.getType('AccountArrRelInsertInput') as GraphQLInputObjectType;
    const fields = arrRelType.getFields();

    expect(fields['onConflict']).toBeDefined();
    const onConflictType = fields['onConflict'].type;
    // onConflict should be nullable (optional)
    expect(onConflictType).not.toBeInstanceOf(GraphQLNonNull);
    expect((onConflictType as GraphQLInputObjectType).name).toBe('AccountOnConflict');
  });

  it('should generate ArrRelInsertInput for multiple tables', () => {
    const typeMap = schema.getTypeMap();
    // Account and Invoice are array relationship targets on Client
    expect(typeMap['AccountArrRelInsertInput']).toBeDefined();
    expect(typeMap['InvoiceArrRelInsertInput']).toBeDefined();
  });
});

// ── InsertInput relationship fields use wrapper types ────────────────────────

describe('P12.1 — InsertInput relationship fields reference wrapper types', () => {
  it('object relationship fields on InsertInput should use ObjRelInsertInput', () => {
    // Client has object relationship "branch" → Branch
    const clientInsertInput = schema.getType('ClientInsertInput') as GraphQLInputObjectType;
    const fields = clientInsertInput.getFields();

    expect(fields['branch']).toBeDefined();
    const branchFieldType = fields['branch'].type;
    // Should be BranchObjRelInsertInput (nullable)
    expect(branchFieldType).not.toBeInstanceOf(GraphQLNonNull);
    expect((branchFieldType as GraphQLInputObjectType).name).toBe('BranchObjRelInsertInput');
  });

  it('array relationship fields on InsertInput should use ArrRelInsertInput', () => {
    // Client has array relationship "accounts" → Account
    const clientInsertInput = schema.getType('ClientInsertInput') as GraphQLInputObjectType;
    const fields = clientInsertInput.getFields();

    expect(fields['accounts']).toBeDefined();
    const accountsFieldType = fields['accounts'].type;
    // Should be AccountArrRelInsertInput (nullable), NOT [AccountInsertInput!]
    expect(accountsFieldType).not.toBeInstanceOf(GraphQLNonNull);
    expect(accountsFieldType).not.toBeInstanceOf(GraphQLList);
    expect((accountsFieldType as GraphQLInputObjectType).name).toBe('AccountArrRelInsertInput');
  });

  it('should not reference raw InsertInput for relationship fields', () => {
    // Verify that the old pattern (direct InsertInput reference) is gone
    const clientInsertInput = schema.getType('ClientInsertInput') as GraphQLInputObjectType;
    const fields = clientInsertInput.getFields();

    // Check that no relationship field type name ends with just "InsertInput"
    // (they should all end with ObjRelInsertInput or ArrRelInsertInput)
    if (fields['branch']) {
      const typeName = (fields['branch'].type as GraphQLInputObjectType).name;
      expect(typeName).toContain('ObjRelInsertInput');
    }
    if (fields['accounts']) {
      const typeName = (fields['accounts'].type as GraphQLInputObjectType).name;
      expect(typeName).toContain('ArrRelInsertInput');
    }
  });

  it('other object relationship fields should also use ObjRelInsertInput', () => {
    const clientInsertInput = schema.getType('ClientInsertInput') as GraphQLInputObjectType;
    const fields = clientInsertInput.getFields();

    // primaryAccount is an object relationship on Client
    if (fields['primaryAccount']) {
      const typeName = (fields['primaryAccount'].type as GraphQLInputObjectType).name;
      expect(typeName).toBe('AccountObjRelInsertInput');
    }
  });

  it('InsertInput should still have all column fields unchanged', () => {
    const clientInsertInput = schema.getType('ClientInsertInput') as GraphQLInputObjectType;
    const fields = clientInsertInput.getFields();

    // Column fields should still exist and not be affected
    expect(fields['id']).toBeDefined();
    expect(fields['username']).toBeDefined();
    expect(fields['email']).toBeDefined();
    expect(fields['branchId']).toBeDefined();
  });
});

// ── Wrapper type field counts (sanity check) ────────────────────────────────

describe('P12.1 — Wrapper type field structure', () => {
  it('ObjRelInsertInput should have exactly 2 fields (data + onConflict) when table has constraints', () => {
    const objRelType = schema.getType('ClientObjRelInsertInput') as GraphQLInputObjectType;
    const fieldNames = Object.keys(objRelType.getFields());
    expect(fieldNames).toContain('data');
    expect(fieldNames).toContain('onConflict');
    expect(fieldNames.length).toBe(2);
  });

  it('ArrRelInsertInput should have exactly 2 fields (data + onConflict) when table has constraints', () => {
    const arrRelType = schema.getType('AccountArrRelInsertInput') as GraphQLInputObjectType;
    const fieldNames = Object.keys(arrRelType.getFields());
    expect(fieldNames).toContain('data');
    expect(fieldNames).toContain('onConflict');
    expect(fieldNames.length).toBe(2);
  });

  it('data field type string on ObjRelInsertInput should be "InsertInput!"', () => {
    const objRelType = schema.getType('ClientObjRelInsertInput') as GraphQLInputObjectType;
    const dataField = objRelType.getFields()['data'];
    expect(dataField.type.toString()).toBe('ClientInsertInput!');
  });

  it('data field type string on ArrRelInsertInput should be "[InsertInput!]!"', () => {
    const arrRelType = schema.getType('AccountArrRelInsertInput') as GraphQLInputObjectType;
    const dataField = arrRelType.getFields()['data'];
    expect(dataField.type.toString()).toBe('[AccountInsertInput!]!');
  });
});
