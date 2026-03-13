import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { HakkyraConfig } from '../src/types.js';
import type { IntrospectionResult } from '../src/introspection/introspector.js';
import { getPool, closePool, waitForDb, METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL } from './setup.js';

let introspection: IntrospectionResult;
let config: HakkyraConfig;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  introspection = await introspectDatabase(pool);
  config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
});

afterAll(async () => {
  await closePool();
});

describe('Database Introspection', () => {
  describe('table discovery', () => {
    it('should discover all test tables', () => {
      const tableNames = introspection.tables.map((t) => t.name);
      expect(tableNames).toContain('client');
      expect(tableNames).toContain('account');
      expect(tableNames).toContain('invoice');
      expect(tableNames).toContain('branch');
      expect(tableNames).toContain('currency');
      expect(tableNames).toContain('product');
      expect(tableNames).toContain('appointment');
      expect(tableNames).toContain('service_plan');
      expect(tableNames).toContain('plan_item');
      expect(tableNames).toContain('ledger_entry');
    });

    it('should discover views including client_summary', () => {
      const clientSummary = introspection.tables.find((t) => t.name === 'client_summary');
      expect(clientSummary).toBeDefined();
    });

    it('should include the public schema', () => {
      for (const table of introspection.tables) {
        expect(table.schema).toBe('public');
      }
    });
  });

  describe('column introspection', () => {
    it('should discover columns with correct types', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      expect(client.columns.length).toBeGreaterThan(0);

      const idCol = client.columns.find((c) => c.name === 'id')!;
      expect(idCol.udtName).toBe('uuid');
      expect(idCol.isNullable).toBe(false);
      expect(idCol.hasDefault).toBe(true);

      const usernameCol = client.columns.find((c) => c.name === 'username')!;
      expect(usernameCol.udtName).toBe('text');
      expect(usernameCol.isNullable).toBe(false);
    });

    it('should detect nullable columns', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      const countryCol = client.columns.find((c) => c.name === 'country_id')!;
      expect(countryCol.isNullable).toBe(true);

      const lastContactCol = client.columns.find((c) => c.name === 'last_contact_at')!;
      expect(lastContactCol.isNullable).toBe(true);
    });

    it('should detect columns with defaults', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      const statusCol = client.columns.find((c) => c.name === 'status')!;
      expect(statusCol.hasDefault).toBe(true);

      const createdAtCol = client.columns.find((c) => c.name === 'created_at')!;
      expect(createdAtCol.hasDefault).toBe(true);
    });

    it('should detect JSONB columns', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      const tagsCol = client.columns.find((c) => c.name === 'tags')!;
      expect(tagsCol.udtName).toBe('jsonb');
    });

    it('should detect numeric columns', () => {
      const account = introspection.tables.find((t) => t.name === 'account')!;
      const balanceCol = account.columns.find((c) => c.name === 'balance')!;
      expect(balanceCol.udtName).toBe('numeric');
    });

    it('should annotate enum column values', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      const statusCol = client.columns.find((c) => c.name === 'status')!;
      expect(statusCol.enumValues).toBeDefined();
      expect(statusCol.enumValues).toContain('active');
      expect(statusCol.enumValues).toContain('on_hold');
    });
  });

  describe('primary key detection', () => {
    it('should detect UUID primary keys', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      expect(client.primaryKey).toEqual(['id']);
    });

    it('should detect text primary keys', () => {
      const currency = introspection.tables.find((t) => t.name === 'currency')!;
      expect(currency.primaryKey).toEqual(['id']);
    });

    it('should detect serial primary keys', () => {
      const role = introspection.tables.find((t) => t.name === 'role')!;
      expect(role.primaryKey).toEqual(['id']);
    });

    it('should mark PK columns with isPrimaryKey flag', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      const idCol = client.columns.find((c) => c.name === 'id')!;
      expect(idCol.isPrimaryKey).toBe(true);

      const usernameCol = client.columns.find((c) => c.name === 'username')!;
      expect(usernameCol.isPrimaryKey).toBe(false);
    });
  });

  describe('foreign key detection', () => {
    it('should detect foreign keys on client', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      expect(client.foreignKeys.length).toBeGreaterThan(0);

      const branchFK = client.foreignKeys.find((fk) => fk.referencedTable === 'branch');
      expect(branchFK).toBeDefined();
      expect(branchFK!.columns).toEqual(['branch_id']);
      expect(branchFK!.referencedColumns).toEqual(['id']);
    });

    it('should detect foreign keys on account', () => {
      const account = introspection.tables.find((t) => t.name === 'account')!;
      const clientFK = account.foreignKeys.find((fk) => fk.referencedTable === 'client');
      expect(clientFK).toBeDefined();
      expect(clientFK!.columns).toEqual(['client_id']);
    });

    it('should detect foreign keys on invoice', () => {
      const invoice = introspection.tables.find((t) => t.name === 'invoice')!;
      const clientFK = invoice.foreignKeys.find((fk) => fk.referencedTable === 'client');
      expect(clientFK).toBeDefined();
      const accountFK = invoice.foreignKeys.find((fk) => fk.referencedTable === 'account');
      expect(accountFK).toBeDefined();
    });
  });

  describe('enum type discovery', () => {
    it('should discover all enum types', () => {
      const enumNames = introspection.enums.map((e) => e.name);
      expect(enumNames).toContain('client_status');
      expect(enumNames).toContain('invoice_state');
      expect(enumNames).toContain('ledger_type');
      expect(enumNames).toContain('plan_state');
      expect(enumNames).toContain('service_status');
    });

    it('should include enum values in correct order', () => {
      const clientStatus = introspection.enums.find((e) => e.name === 'client_status')!;
      expect(clientStatus.values).toEqual(['active', 'on_hold', 'inactive', 'archived']);
    });
  });

  describe('function discovery', () => {
    it('should discover computed field functions', () => {
      const fnNames = introspection.functions.map((f) => f.name);
      expect(fnNames).toContain('client_total_balance');
      expect(fnNames).toContain('account_total');
    });

    it('should report function volatility', () => {
      const accountTotal = introspection.functions.find((f) => f.name === 'account_total')!;
      expect(accountTotal.volatility).toBe('immutable');

      const clientBalance = introspection.functions.find((f) => f.name === 'client_total_balance')!;
      expect(clientBalance.volatility).toBe('stable');
    });
  });

  describe('index discovery', () => {
    it('should discover indexes on client table', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      const indexNames = client.indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_client_branch');
      expect(indexNames).toContain('idx_client_status');
    });

    it('should report unique indexes', () => {
      const client = introspection.tables.find((t) => t.name === 'client')!;
      const usernameIdx = client.indexes.find((i) => i.columns.includes('username'));
      if (usernameIdx) {
        expect(usernameIdx.isUnique).toBe(true);
      }
    });
  });
});

describe('Schema Merger', () => {
  it('should merge introspection with config into a SchemaModel', () => {
    const result = mergeSchemaModel(introspection, config);
    expect(result.model).toBeDefined();
    expect(result.model.tables.length).toBeGreaterThan(0);
    expect(result.model.enums.length).toBeGreaterThan(0);
  });

  it('should merge relationships from config onto introspected tables', () => {
    const result = mergeSchemaModel(introspection, config);
    const client = result.model.tables.find((t) => t.name === 'client')!;
    expect(client.relationships.length).toBeGreaterThan(0);

    const accountsRel = client.relationships.find((r) => r.name === 'accounts');
    expect(accountsRel).toBeDefined();
    expect(accountsRel!.type).toBe('array');

    const branchRel = client.relationships.find((r) => r.name === 'branch');
    expect(branchRel).toBeDefined();
    expect(branchRel!.type).toBe('object');
  });

  it('should apply permissions from config to merged tables', () => {
    const result = mergeSchemaModel(introspection, config);
    const client = result.model.tables.find((t) => t.name === 'client')!;
    expect(client.permissions.select['client']).toBeDefined();
    expect(client.permissions.select['backoffice']).toBeDefined();
    expect(client.permissions.insert['backoffice']).toBeDefined();
    expect(client.permissions.update['client']).toBeDefined();
    expect(client.permissions.delete['administrator']).toBeDefined();
  });

  it('should preserve introspected columns on merged tables', () => {
    const result = mergeSchemaModel(introspection, config);
    const client = result.model.tables.find((t) => t.name === 'client')!;
    expect(client.columns.length).toBeGreaterThan(0);
    expect(client.columns.find((c) => c.name === 'id')).toBeDefined();
    expect(client.columns.find((c) => c.name === 'username')).toBeDefined();
  });

  it('should preserve primary keys from introspection', () => {
    const result = mergeSchemaModel(introspection, config);
    const client = result.model.tables.find((t) => t.name === 'client')!;
    expect(client.primaryKey).toEqual(['id']);
  });

  it('should include enums and functions from introspection', () => {
    const result = mergeSchemaModel(introspection, config);
    expect(result.model.enums.length).toBeGreaterThan(0);
    expect(result.model.functions.length).toBeGreaterThan(0);
  });

  it('should report warnings for tables in config but not in DB', () => {
    const badConfig = {
      ...config,
      tables: [
        ...config.tables,
        {
          name: 'nonexistent_table',
          schema: 'public',
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          uniqueConstraints: [],
          indexes: [],
          relationships: [],
          permissions: { select: {}, insert: {}, update: {}, delete: {} },
          eventTriggers: [],
        },
      ],
    };
    const result = mergeSchemaModel(introspection, badConfig);
    expect(result.warnings.some((w) => w.type === 'missing_table')).toBe(true);
  });

  it('should apply custom root fields from config', () => {
    const result = mergeSchemaModel(introspection, config);
    const client = result.model.tables.find((t) => t.name === 'client')!;
    expect(client.customRootFields?.select).toBe('clients');
    expect(client.customRootFields?.select_by_pk).toBe('clientByPk');
  });
});
