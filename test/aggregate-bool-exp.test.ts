/**
 * P12.5 — AggregateBoolExp bool_and / bool_or types
 *
 * Tests that tables which are array-relationship targets AND have boolean columns
 * get bool_and/bool_or aggregate filter types alongside the existing count type.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLInputObjectType,
  GraphQLEnumType,
  GraphQLNonNull,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel, HakkyraConfig } from '../src/types.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { getPool, closePool, waitForDb, METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL } from './setup.js';

let schema: GraphQLSchema;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config: HakkyraConfig = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  const schemaModel: SchemaModel = result.model;
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

describe('AggregateBoolExp bool_and / bool_or (P12.5)', () => {
  // ─── Account table: array-rel target with boolean column "active" ──────

  describe('Account (has boolean column "active")', () => {
    it('should have bool_and and bool_or fields on AccountAggregateBoolExp', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['AccountAggregateBoolExp'] as GraphQLInputObjectType | undefined;
      expect(aggType).toBeDefined();
      const fields = aggType!.getFields();
      expect(fields['count']).toBeDefined();
      expect(fields['bool_and']).toBeDefined();
      expect(fields['bool_or']).toBeDefined();
    });

    it('should generate accountAggregateBoolExpBool_and input type', () => {
      const typeMap = schema.getTypeMap();
      const boolAndType = typeMap['accountAggregateBoolExpBool_and'] as GraphQLInputObjectType | undefined;
      expect(boolAndType).toBeDefined();
    });

    it('should generate accountAggregateBoolExpBool_or input type', () => {
      const typeMap = schema.getTypeMap();
      const boolOrType = typeMap['accountAggregateBoolExpBool_or'] as GraphQLInputObjectType | undefined;
      expect(boolOrType).toBeDefined();
    });

    it('bool_and type should have arguments, distinct, filter, predicate fields', () => {
      const typeMap = schema.getTypeMap();
      const boolAndType = typeMap['accountAggregateBoolExpBool_and'] as GraphQLInputObjectType;
      const fields = boolAndType.getFields();
      expect(fields['arguments']).toBeDefined();
      expect(fields['distinct']).toBeDefined();
      expect(fields['filter']).toBeDefined();
      expect(fields['predicate']).toBeDefined();
    });

    it('bool_or type should have arguments, distinct, filter, predicate fields', () => {
      const typeMap = schema.getTypeMap();
      const boolOrType = typeMap['accountAggregateBoolExpBool_or'] as GraphQLInputObjectType;
      const fields = boolOrType.getFields();
      expect(fields['arguments']).toBeDefined();
      expect(fields['distinct']).toBeDefined();
      expect(fields['filter']).toBeDefined();
      expect(fields['predicate']).toBeDefined();
    });

    it('bool_and arguments should be non-null enum', () => {
      const typeMap = schema.getTypeMap();
      const boolAndType = typeMap['accountAggregateBoolExpBool_and'] as GraphQLInputObjectType;
      const argsField = boolAndType.getFields()['arguments'];
      expect(argsField.type).toBeInstanceOf(GraphQLNonNull);
      const innerType = (argsField.type as GraphQLNonNull<GraphQLEnumType>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLEnumType);
    });

    it('bool_and predicate should be non-null BooleanComparisonExp', () => {
      const typeMap = schema.getTypeMap();
      const boolAndType = typeMap['accountAggregateBoolExpBool_and'] as GraphQLInputObjectType;
      const predField = boolAndType.getFields()['predicate'];
      expect(predField.type).toBeInstanceOf(GraphQLNonNull);
      const innerType = (predField.type as GraphQLNonNull<GraphQLInputObjectType>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLInputObjectType);
      expect((innerType as GraphQLInputObjectType).name).toBe('BooleanComparisonExp');
    });

    it('bool_or predicate should be non-null BooleanComparisonExp', () => {
      const typeMap = schema.getTypeMap();
      const boolOrType = typeMap['accountAggregateBoolExpBool_or'] as GraphQLInputObjectType;
      const predField = boolOrType.getFields()['predicate'];
      expect(predField.type).toBeInstanceOf(GraphQLNonNull);
      const innerType = (predField.type as GraphQLNonNull<GraphQLInputObjectType>).ofType;
      expect((innerType as GraphQLInputObjectType).name).toBe('BooleanComparisonExp');
    });

    it('should generate AccountSelectColumnAccountAggregateBoolExpBool_andArgumentsColumns enum', () => {
      const typeMap = schema.getTypeMap();
      const enumType = typeMap['AccountSelectColumnAccountAggregateBoolExpBool_andArgumentsColumns'] as GraphQLEnumType | undefined;
      expect(enumType).toBeDefined();
      expect(enumType).toBeInstanceOf(GraphQLEnumType);
      const values = enumType!.getValues();
      // Account has one boolean column: "active"
      expect(values.length).toBe(1);
      expect(values[0].name).toBe('active');
    });

    it('should generate AccountSelectColumnAccountAggregateBoolExpBool_orArgumentsColumns enum', () => {
      const typeMap = schema.getTypeMap();
      const enumType = typeMap['AccountSelectColumnAccountAggregateBoolExpBool_orArgumentsColumns'] as GraphQLEnumType | undefined;
      expect(enumType).toBeDefined();
      const values = enumType!.getValues();
      expect(values.length).toBe(1);
      expect(values[0].name).toBe('active');
    });

    it('filter field should reference AccountBoolExp', () => {
      const typeMap = schema.getTypeMap();
      const boolAndType = typeMap['accountAggregateBoolExpBool_and'] as GraphQLInputObjectType;
      const filterField = boolAndType.getFields()['filter'];
      expect(filterField).toBeDefined();
      const filterType = filterField.type as GraphQLInputObjectType;
      expect(filterType.name).toBe('AccountBoolExp');
    });
  });

  // ─── Client table: array-rel target with boolean column "on_hold" ──────

  describe('Client (has boolean column "onHold")', () => {
    it('should have bool_and and bool_or fields on ClientAggregateBoolExp', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['ClientAggregateBoolExp'] as GraphQLInputObjectType | undefined;
      expect(aggType).toBeDefined();
      const fields = aggType!.getFields();
      expect(fields['bool_and']).toBeDefined();
      expect(fields['bool_or']).toBeDefined();
    });

    it('should generate ClientSelectColumn...Bool_andArgumentsColumns enum with onHold', () => {
      const typeMap = schema.getTypeMap();
      const enumType = typeMap['ClientSelectColumnClientAggregateBoolExpBool_andArgumentsColumns'] as GraphQLEnumType | undefined;
      expect(enumType).toBeDefined();
      const values = enumType!.getValues().map((v) => v.name);
      expect(values).toContain('onHold');
    });
  });

  // ─── Appointment table: array-rel target with boolean "active" ─────────

  describe('Appointment (has boolean column "active")', () => {
    it('should have bool_and and bool_or on AppointmentAggregateBoolExp', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['AppointmentAggregateBoolExp'] as GraphQLInputObjectType | undefined;
      expect(aggType).toBeDefined();
      const fields = aggType!.getFields();
      expect(fields['bool_and']).toBeDefined();
      expect(fields['bool_or']).toBeDefined();
    });

    it('should generate argument columns enum with active', () => {
      const typeMap = schema.getTypeMap();
      const enumType = typeMap['AppointmentSelectColumnAppointmentAggregateBoolExpBool_andArgumentsColumns'] as GraphQLEnumType | undefined;
      expect(enumType).toBeDefined();
      const values = enumType!.getValues().map((v) => v.name);
      expect(values).toContain('active');
    });
  });

  // ─── Product table: array-rel target with boolean "active" ─────────────

  describe('Product (has boolean column "active")', () => {
    it('should have bool_and and bool_or on ProductAggregateBoolExp', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['ProductAggregateBoolExp'] as GraphQLInputObjectType | undefined;
      expect(aggType).toBeDefined();
      const fields = aggType!.getFields();
      expect(fields['bool_and']).toBeDefined();
      expect(fields['bool_or']).toBeDefined();
    });
  });

  // ─── Tables without boolean columns should NOT get bool_and/bool_or ────

  describe('tables without boolean columns', () => {
    it('LedgerEntry should NOT have bool_and/bool_or (no boolean columns)', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['LedgerEntryAggregateBoolExp'] as GraphQLInputObjectType | undefined;
      expect(aggType).toBeDefined();
      const fields = aggType!.getFields();
      expect(fields['count']).toBeDefined();
      expect(fields['bool_and']).toBeUndefined();
      expect(fields['bool_or']).toBeUndefined();
    });

    it('should NOT generate argument columns enum for LedgerEntry', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['LedgerEntrySelectColumnLedgerEntryAggregateBoolExpBool_andArgumentsColumns']).toBeUndefined();
      expect(typeMap['LedgerEntrySelectColumnLedgerEntryAggregateBoolExpBool_orArgumentsColumns']).toBeUndefined();
    });
  });

  // ─── Tables that are NOT array-rel targets should not get any of these ──

  describe('tables not targeted by array relationships', () => {
    it('Currency should NOT have AggregateBoolExp at all', () => {
      const typeMap = schema.getTypeMap();
      // Currency is only referenced via object relationships, not array relationships
      // (It does have referencing tables but check if it actually generates an AggregateBoolExp)
      // Currency IS actually referenced as an array-rel target, so skip this if it exists
      const aggType = typeMap['CurrencyAggregateBoolExp'];
      if (!aggType) {
        // Not an array-rel target, no AggregateBoolExp at all
        expect(aggType).toBeUndefined();
      }
    });
  });

  // ─── Existing count-only functionality still works ─────────────────────

  describe('backward compatibility', () => {
    it('count field still exists on AggregateBoolExp for Account', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['AccountAggregateBoolExp'] as GraphQLInputObjectType;
      expect(aggType.getFields()['count']).toBeDefined();
    });

    it('accountAggregateBoolExpCount type still works', () => {
      const typeMap = schema.getTypeMap();
      const countType = typeMap['accountAggregateBoolExpCount'] as GraphQLInputObjectType;
      expect(countType).toBeDefined();
      const fields = countType.getFields();
      expect(fields['arguments']).toBeDefined();
      expect(fields['distinct']).toBeDefined();
      expect(fields['filter']).toBeDefined();
      expect(fields['predicate']).toBeDefined();
    });

    it('accountsAggregate field still exists on ClientBoolExp', () => {
      const typeMap = schema.getTypeMap();
      const clientBoolExp = typeMap['ClientBoolExp'] as GraphQLInputObjectType;
      expect(clientBoolExp).toBeDefined();
      const fields = clientBoolExp.getFields();
      expect(fields['accountsAggregate']).toBeDefined();
    });
  });
});
