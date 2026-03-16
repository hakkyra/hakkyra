import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema } from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel, OperationsConfig, TableInfo } from '../src/types.js';
import { getPool, closePool, waitForDb, METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL } from './setup.js';

let schemaModel: SchemaModel;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
});

afterAll(async () => {
  await closePool();
});

/**
 * Deep-clone the schema model to avoid shared mutable state between generateSchema calls.
 */
function cloneModel(): SchemaModel {
  return JSON.parse(JSON.stringify(schemaModel)) as SchemaModel;
}

/**
 * Helper: generate schema with global operations applied to ALL tables.
 * Resets the comparison type cache to avoid duplicate type name errors.
 */
function generateWithGlobalOps(ops: Partial<OperationsConfig>): GraphQLSchema {
  const merged = { ...allEnabled(), ...ops };
  const model = cloneModel();
  for (const t of model.tables) {
    t.operations = merged;
  }
  resetComparisonTypeCache();
  return generateSchema(model);
}

/**
 * Helper: generate schema with global operations + per-table override.
 * Resets the comparison type cache to avoid duplicate type name errors.
 */
function generateWithGlobalAndPerTable(
  globalOps: Partial<OperationsConfig>,
  tableName: string,
  tableOps: Partial<OperationsConfig>,
): GraphQLSchema {
  const globalMerged = { ...allEnabled(), ...globalOps };
  const model = cloneModel();
  for (const t of model.tables) {
    if (t.name === tableName) {
      t.operations = { ...globalMerged, ...tableOps };
    } else {
      t.operations = globalMerged;
    }
  }
  resetComparisonTypeCache();
  return generateSchema(model);
}

function allEnabled(): OperationsConfig {
  return {
    select: true,
    selectByPk: true,
    selectAggregate: true,
    insert: true,
    insertOne: true,
    update: true,
    updateByPk: true,
    updateMany: true,
    delete: true,
    deleteByPk: true,
  };
}

describe('P9.8 — Global CRUD Operation Controls', () => {
  describe('default behavior (all operations enabled)', () => {
    it('should expose all query root fields when all ops are enabled', () => {
      const schema = generateWithGlobalOps({});
      const queryFields = schema.getQueryType()!.getFields();
      // "country" table should have all select fields
      expect(queryFields['country']).toBeDefined();
      expect(queryFields['countryByPk']).toBeDefined();
      expect(queryFields['countryAggregate']).toBeDefined();
    });

    it('should expose all mutation root fields when all ops are enabled', () => {
      const schema = generateWithGlobalOps({});
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['insertCountry']).toBeDefined();
      expect(mutFields['insertCountryOne']).toBeDefined();
      expect(mutFields['updateCountry']).toBeDefined();
      expect(mutFields['updateCountryByPk']).toBeDefined();
      expect(mutFields['deleteCountry']).toBeDefined();
      expect(mutFields['deleteCountryByPk']).toBeDefined();
    });
  });

  describe('globally disabled non-PK delete', () => {
    it('should hide deleteCountry but keep deleteCountryByPk', () => {
      const schema = generateWithGlobalOps({ delete: false });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['deleteCountry']).toBeUndefined();
      expect(mutFields['deleteCountryByPk']).toBeDefined();
    });

    it('should hide delete fields for ALL tables when globally disabled', () => {
      const schema = generateWithGlobalOps({ delete: false });
      const mutFields = schema.getMutationType()!.getFields();
      // Batch delete should be gone for all tables
      expect(mutFields['deleteCountry']).toBeUndefined();
      expect(mutFields['deleteClients']).toBeUndefined();
      // PK delete should still exist
      expect(mutFields['deleteCountryByPk']).toBeDefined();
      expect(mutFields['deleteClientByPk']).toBeDefined();
    });
  });

  describe('globally disabled non-PK update and updateMany', () => {
    it('should hide updateCountry and updateCountryMany but keep updateCountryByPk', () => {
      const schema = generateWithGlobalOps({ update: false, updateMany: false });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['updateCountry']).toBeUndefined();
      expect(mutFields['updateCountryMany']).toBeUndefined();
      expect(mutFields['updateCountryByPk']).toBeDefined();
    });
  });

  describe('independently controllable PK vs non-PK operations', () => {
    it('can disable delete but keep deleteByPk', () => {
      const schema = generateWithGlobalOps({ delete: false, deleteByPk: true });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['deleteCountry']).toBeUndefined();
      expect(mutFields['deleteCountryByPk']).toBeDefined();
    });

    it('can disable deleteByPk but keep delete', () => {
      const schema = generateWithGlobalOps({ delete: true, deleteByPk: false });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['deleteCountry']).toBeDefined();
      expect(mutFields['deleteCountryByPk']).toBeUndefined();
    });

    it('can disable update but keep updateByPk', () => {
      const schema = generateWithGlobalOps({ update: false, updateByPk: true });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['updateCountry']).toBeUndefined();
      expect(mutFields['updateCountryByPk']).toBeDefined();
    });

    it('can disable updateByPk but keep update', () => {
      const schema = generateWithGlobalOps({ update: true, updateByPk: false });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['updateCountry']).toBeDefined();
      expect(mutFields['updateCountryByPk']).toBeUndefined();
    });

    it('can disable insert but keep insertOne', () => {
      const schema = generateWithGlobalOps({ insert: false, insertOne: true });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['insertCountry']).toBeUndefined();
      expect(mutFields['insertCountryOne']).toBeDefined();
    });

    it('can disable insertOne but keep insert', () => {
      const schema = generateWithGlobalOps({ insert: true, insertOne: false });
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['insertCountry']).toBeDefined();
      expect(mutFields['insertCountryOne']).toBeUndefined();
    });
  });

  describe('disabling select operations', () => {
    it('should hide select list field from query and subscription', () => {
      const schema = generateWithGlobalOps({ select: false });
      const queryFields = schema.getQueryType()!.getFields();
      expect(queryFields['country']).toBeUndefined();
      expect(queryFields['countryByPk']).toBeDefined();
      expect(queryFields['countryAggregate']).toBeDefined();
      // Subscription should also respect it
      const subType = schema.getSubscriptionType();
      if (subType) {
        const subFields = subType.getFields();
        expect(subFields['country']).toBeUndefined();
      }
    });

    it('should hide selectByPk from query and subscription', () => {
      const schema = generateWithGlobalOps({ selectByPk: false });
      const queryFields = schema.getQueryType()!.getFields();
      expect(queryFields['country']).toBeDefined();
      expect(queryFields['countryByPk']).toBeUndefined();
      const subType = schema.getSubscriptionType();
      if (subType) {
        const subFields = subType.getFields();
        expect(subFields['countryByPk']).toBeUndefined();
      }
    });

    it('should hide selectAggregate from query', () => {
      const schema = generateWithGlobalOps({ selectAggregate: false });
      const queryFields = schema.getQueryType()!.getFields();
      expect(queryFields['country']).toBeDefined();
      expect(queryFields['countryAggregate']).toBeUndefined();
    });
  });

  describe('per-table override re-enables globally disabled operations', () => {
    it('should re-enable delete for country when globally disabled', () => {
      const schema = generateWithGlobalAndPerTable(
        { delete: false },
        'country',
        { delete: true },
      );
      const mutFields = schema.getMutationType()!.getFields();
      // country: globally disabled delete is re-enabled by per-table override
      expect(mutFields['deleteCountry']).toBeDefined();
      expect(mutFields['deleteCountryByPk']).toBeDefined();
      // other tables: batch delete still disabled
      expect(mutFields['deleteClients']).toBeUndefined();
      expect(mutFields['deleteClientByPk']).toBeDefined();
    });

    it('should re-enable update for country when globally disabled', () => {
      const schema = generateWithGlobalAndPerTable(
        { update: false },
        'country',
        { update: true },
      );
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['updateCountry']).toBeDefined();
      // other tables: batch update still disabled
      expect(mutFields['updateClients']).toBeUndefined();
    });

    it('per-table can disable an operation that is globally enabled', () => {
      const schema = generateWithGlobalAndPerTable(
        {},  // all enabled globally
        'country',
        { insert: false, insertOne: false },
      );
      const mutFields = schema.getMutationType()!.getFields();
      expect(mutFields['insertCountry']).toBeUndefined();
      expect(mutFields['insertCountryOne']).toBeUndefined();
      // other tables still have insert
      expect(mutFields['insertClients']).toBeDefined();
      expect(mutFields['insertClient']).toBeDefined();
    });
  });

  describe('multiple operations disabled together', () => {
    it('should hide all mutation fields when all mutations are disabled', () => {
      const schema = generateWithGlobalOps({
        insert: false,
        insertOne: false,
        update: false,
        updateByPk: false,
        updateMany: false,
        delete: false,
        deleteByPk: false,
      });
      const mutFields = schema.getMutationType()?.getFields() ?? {};
      // No table mutation fields should exist for country
      expect(mutFields['insertCountry']).toBeUndefined();
      expect(mutFields['insertCountryOne']).toBeUndefined();
      expect(mutFields['updateCountry']).toBeUndefined();
      expect(mutFields['updateCountryByPk']).toBeUndefined();
      expect(mutFields['deleteCountry']).toBeUndefined();
      expect(mutFields['deleteCountryByPk']).toBeUndefined();
    });

    it('should keep query fields even when all mutations are disabled', () => {
      const schema = generateWithGlobalOps({
        insert: false,
        insertOne: false,
        update: false,
        updateByPk: false,
        updateMany: false,
        delete: false,
        deleteByPk: false,
      });
      const queryFields = schema.getQueryType()!.getFields();
      expect(queryFields['country']).toBeDefined();
      expect(queryFields['countryByPk']).toBeDefined();
      expect(queryFields['countryAggregate']).toBeDefined();
    });
  });

  describe('operations config propagated via loadConfig', () => {
    it('should have operations set on tables after loading config', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      // All tables should have operations set (merged with defaults)
      for (const table of config.tables) {
        expect(table.operations).toBeDefined();
        expect(table.operations!.select).toBe(true);
        expect(table.operations!.delete).toBe(true);
      }
    });
  });
});
