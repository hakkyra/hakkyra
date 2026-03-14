/**
 * Tests for relationship ordering:
 * - Object relationship ordering (LEFT JOIN + ORDER BY)
 * - Array relationship aggregate ordering (correlated subquery in ORDER BY)
 *
 * Phase 5.3: Relationship Ordering
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema, GraphQLInputObjectType } from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetCustomOutputTypeCache } from '../src/schema/custom-queries.js';
import { compileSelect } from '../src/sql/select.js';
import type { OrderByItem } from '../src/sql/select.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel, TableInfo } from '../src/types.js';
import {
  getPool, closePool, waitForDb, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
} from './setup.js';

let schemaModel: SchemaModel;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  resetCustomOutputTypeCache();
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

// ─── Schema Generation Tests ────────────────────────────────────────────────

describe('OrderBy schema generation', () => {
  let schema: GraphQLSchema;

  beforeAll(() => {
    resetCustomOutputTypeCache();
    schema = generateSchema(schemaModel);
  });

  // -- Object relationship fields --

  it('should include object relationship fields in OrderBy input type', () => {
    const clientOrderBy = schema.getType('ClientOrderBy') as GraphQLInputObjectType;
    expect(clientOrderBy).toBeDefined();
    const fields = clientOrderBy.getFields();

    // Client has object relationships: branch, currency, country, language
    expect(fields['branch']).toBeDefined();
    expect(fields['currency']).toBeDefined();
    expect(fields['country']).toBeDefined();
    expect(fields['language']).toBeDefined();

    // The type of these fields should be the related table's OrderBy type
    expect(fields['branch'].type.toString()).toBe('BranchOrderBy');
    expect(fields['currency'].type.toString()).toBe('CurrencyOrderBy');
  });

  it('should include object relationship fields in InvoiceOrderBy', () => {
    const invoiceOrderBy = schema.getType('InvoiceOrderBy') as GraphQLInputObjectType;
    expect(invoiceOrderBy).toBeDefined();
    const fields = invoiceOrderBy.getFields();

    // Invoice has object relationships: client, account, currency
    expect(fields['client']).toBeDefined();
    expect(fields['account']).toBeDefined();
    expect(fields['currency']).toBeDefined();
  });

  it('should still include regular column fields in OrderBy', () => {
    const clientOrderBy = schema.getType('ClientOrderBy') as GraphQLInputObjectType;
    const fields = clientOrderBy.getFields();

    // Regular columns should still be present
    expect(fields['id']).toBeDefined();
    expect(fields['username']).toBeDefined();
    expect(fields['email']).toBeDefined();
    expect(fields['createdAt']).toBeDefined();
  });

  // -- Array relationship aggregate fields --

  it('should generate AggregateOrderBy types for tables with array relationships', () => {
    // Account table is a target of array relationships — it should have an AggregateOrderBy
    const accountAggOrderBy = schema.getType('AccountAggregateOrderBy') as GraphQLInputObjectType;
    expect(accountAggOrderBy).toBeDefined();
    const fields = accountAggOrderBy.getFields();

    // Should have count + per-function types
    expect(fields['count']).toBeDefined();
    expect(fields['avg']).toBeDefined();
    expect(fields['sum']).toBeDefined();
    expect(fields['max']).toBeDefined();
    expect(fields['min']).toBeDefined();
    expect(fields['stddev']).toBeDefined();
    expect(fields['stddevPop']).toBeDefined();
    expect(fields['stddevSamp']).toBeDefined();
    expect(fields['varPop']).toBeDefined();
    expect(fields['varSamp']).toBeDefined();
    expect(fields['variance']).toBeDefined();
  });

  it('should generate per-function aggregate order types with numeric columns', () => {
    // Account has numeric columns: balance, credit_balance, pending_balance
    const accountAvgOrderBy = schema.getType('AccountAvgOrderBy') as GraphQLInputObjectType;
    expect(accountAvgOrderBy).toBeDefined();
    const fields = accountAvgOrderBy.getFields();

    expect(fields['balance']).toBeDefined();
    expect(fields['creditBalance']).toBeDefined();
    expect(fields['pendingBalance']).toBeDefined();
  });

  it('should include aggregate ordering fields on parent OrderBy types', () => {
    const clientOrderBy = schema.getType('ClientOrderBy') as GraphQLInputObjectType;
    const fields = clientOrderBy.getFields();

    // Client has array relationships: accounts, invoices, etc.
    expect(fields['accountsAggregate']).toBeDefined();
    expect(fields['invoicesAggregate']).toBeDefined();

    // The type should be the AggregateOrderBy for the target table
    expect(fields['accountsAggregate'].type.toString()).toBe('AccountAggregateOrderBy');
    expect(fields['invoicesAggregate'].type.toString()).toBe('InvoiceAggregateOrderBy');
  });

  it('should generate InvoiceAggregateOrderBy with numeric columns', () => {
    const invoiceAggOrderBy = schema.getType('InvoiceAggregateOrderBy') as GraphQLInputObjectType;
    expect(invoiceAggOrderBy).toBeDefined();
    const fields = invoiceAggOrderBy.getFields();
    expect(fields['count']).toBeDefined();

    // Check per-function types
    const invoiceSumOrderBy = schema.getType('InvoiceSumOrderBy') as GraphQLInputObjectType;
    expect(invoiceSumOrderBy).toBeDefined();
    const sumFields = invoiceSumOrderBy.getFields();
    expect(sumFields['amount']).toBeDefined();
  });
});

// ─── SQL Compiler Tests ─────────────────────────────────────────────────────

describe('SQL: object relationship ordering', () => {
  const adminSession = makeSession('admin');

  it('should compile SELECT with object relationship ordering via LEFT JOIN', () => {
    const clientTable = findTable('client');
    const branchTable = findTable('branch');
    const branchRel = clientTable.relationships.find((r) => r.name === 'branch')!;

    const orderBy: OrderByItem[] = [{
      column: '',
      direction: 'asc',
      relationship: {
        config: branchRel,
        remoteTable: branchTable,
        orderByItem: { column: 'name', direction: 'asc' },
      },
    }];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      orderBy,
      session: adminSession,
    });

    // Should contain LEFT JOIN for the branch table
    expect(compiled.sql).toContain('LEFT JOIN');
    expect(compiled.sql).toContain('"branch"');
    expect(compiled.sql).toContain('ORDER BY');
    expect(compiled.sql).toContain('"name"');
  });

  it('should execute SELECT ordered by object relationship field', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const currencyTable = findTable('currency');
    const currencyRel = clientTable.relationships.find((r) => r.name === 'currency')!;

    const orderBy: OrderByItem[] = [{
      column: '',
      direction: 'asc',
      relationship: {
        config: currencyRel,
        remoteTable: currencyTable,
        orderByItem: { column: 'name', direction: 'asc' },
      },
    }];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username', 'currency_id'],
      orderBy,
      session: adminSession,
    });

    const result = await pool.query(compiled.sql, compiled.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(4);

    // Verify ordering by currency name: British Pound < Euro < US Dollar
    // diana (GBP/British Pound), alice (EUR/Euro), charlie (EUR/Euro), bob (USD/US Dollar)
    expect(data[0].currency_id).toBe('GBP');
    // alice and charlie both have EUR, order between them is non-deterministic
    expect([data[1].currency_id, data[2].currency_id]).toEqual(['EUR', 'EUR']);
    expect(data[3].currency_id).toBe('USD');
  });

  it('should handle mixed column and relationship ordering', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const currencyTable = findTable('currency');
    const currencyRel = clientTable.relationships.find((r) => r.name === 'currency')!;

    // Order by currency name ASC, then username ASC to break ties
    const orderBy: OrderByItem[] = [
      {
        column: '',
        direction: 'asc',
        relationship: {
          config: currencyRel,
          remoteTable: currencyTable,
          orderByItem: { column: 'name', direction: 'asc' },
        },
      },
      { column: 'username', direction: 'asc' },
    ];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username', 'currency_id'],
      orderBy,
      session: adminSession,
    });

    const result = await pool.query(compiled.sql, compiled.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(4);

    // diana (GBP/British Pound), then alice, charlie (EUR/Euro alphabetical), then bob (USD)
    expect(data[0].username).toBe('diana');
    expect(data[1].username).toBe('alice');
    expect(data[2].username).toBe('charlie');
    expect(data[3].username).toBe('bob');
  });
});

describe('SQL: array relationship aggregate ordering', () => {
  const adminSession = makeSession('admin');

  it('should compile SELECT with aggregate count ordering', () => {
    const clientTable = findTable('client');
    const invoiceTable = findTable('invoice');
    const invoicesRel = clientTable.relationships.find((r) => r.name === 'invoices')!;

    const orderBy: OrderByItem[] = [{
      column: '',
      direction: 'desc',
      aggregate: {
        config: invoicesRel,
        remoteTable: invoiceTable,
        function: 'count',
      },
    }];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      orderBy,
      session: adminSession,
    });

    // Should contain a correlated subquery with count(*)
    expect(compiled.sql).toContain('count(*)');
    expect(compiled.sql).toContain('ORDER BY');
    expect(compiled.sql).toContain('DESC');
  });

  it('should execute SELECT ordered by count of array relationship', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const invoiceTable = findTable('invoice');
    const invoicesRel = clientTable.relationships.find((r) => r.name === 'invoices')!;

    // Order clients by number of invoices DESC
    const orderBy: OrderByItem[] = [{
      column: '',
      direction: 'desc',
      aggregate: {
        config: invoicesRel,
        remoteTable: invoiceTable,
        function: 'count',
      },
    }];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      orderBy,
      session: adminSession,
    });

    const result = await pool.query(compiled.sql, compiled.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(4);

    // alice has 2 invoices, bob has 1, diana has 1, charlie has 0
    // alice should come first
    expect(data[0].username).toBe('alice');
    // charlie should come last
    expect(data[3].username).toBe('charlie');
  });

  it('should compile SELECT with aggregate sum ordering', () => {
    const clientTable = findTable('client');
    const invoiceTable = findTable('invoice');
    const invoicesRel = clientTable.relationships.find((r) => r.name === 'invoices')!;

    const orderBy: OrderByItem[] = [{
      column: '',
      direction: 'desc',
      aggregate: {
        config: invoicesRel,
        remoteTable: invoiceTable,
        function: 'sum',
        column: 'amount',
      },
    }];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      orderBy,
      session: adminSession,
    });

    // Should contain sum(alias.column) in a subquery
    expect(compiled.sql).toContain('sum(');
    expect(compiled.sql).toContain('"amount"');
    expect(compiled.sql).toContain('ORDER BY');
  });

  it('should execute SELECT ordered by sum of array relationship column', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const invoiceTable = findTable('invoice');
    const invoicesRel = clientTable.relationships.find((r) => r.name === 'invoices')!;

    // Order clients by sum of invoice amounts DESC NULLS LAST
    // (charlie has no invoices, sum returns NULL; NULLS LAST pushes them to end)
    const orderBy: OrderByItem[] = [{
      column: '',
      direction: 'desc',
      nulls: 'last',
      aggregate: {
        config: invoicesRel,
        remoteTable: invoiceTable,
        function: 'sum',
        column: 'amount',
      },
    }];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      orderBy,
      session: adminSession,
    });

    const result = await pool.query(compiled.sql, compiled.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(4);

    // Verify the ordering is correct by checking the SQL produces the right correlated subquery
    expect(compiled.sql).toContain('sum(');
    expect(compiled.sql).toContain('"amount"');
    expect(compiled.sql).toContain('DESC NULLS LAST');

    // Verify the actual sums by direct query
    const verifyResult = await pool.query(`
      SELECT c.username, (SELECT sum(i.amount) FROM invoice i WHERE i.client_id = c.id) as total
      FROM client c ORDER BY total DESC NULLS LAST
    `);
    const expected = verifyResult.rows.map((r: Record<string, unknown>) => r.username);

    // diana has 5000, bob has 200, alice has 150 (100+50), charlie has NULL
    // DESC NULLS LAST: diana, bob, alice, charlie
    const actual = data.map((r: Record<string, unknown>) => r.username);
    expect(actual).toEqual(expected);
  });

  it('should handle aggregate avg ordering', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const invoiceTable = findTable('invoice');
    const invoicesRel = clientTable.relationships.find((r) => r.name === 'invoices')!;

    // Order clients by average invoice amount DESC NULLS LAST
    const orderBy: OrderByItem[] = [{
      column: '',
      direction: 'desc',
      nulls: 'last',
      aggregate: {
        config: invoicesRel,
        remoteTable: invoiceTable,
        function: 'avg',
        column: 'amount',
      },
    }];

    const compiled = compileSelect({
      table: clientTable,
      columns: ['id', 'username'],
      orderBy,
      session: adminSession,
    });

    const result = await pool.query(compiled.sql, compiled.params);
    const data = result.rows[0].data;
    expect(data.length).toBe(4);

    // Verify against direct query
    const verifyResult = await pool.query(`
      SELECT c.username, (SELECT avg(i.amount) FROM invoice i WHERE i.client_id = c.id) as avg_amount
      FROM client c ORDER BY avg_amount DESC NULLS LAST
    `);
    const expected = verifyResult.rows.map((r: Record<string, unknown>) => r.username);
    const actual = data.map((r: Record<string, unknown>) => r.username);
    expect(actual).toEqual(expected);

    // Basic sanity: diana (5000 avg) should be first, charlie (no invoices) should be last
    expect(data[0].username).toBe('diana');
    expect(data[3].username).toBe('charlie');
  });
});

// E2E tests for relationship ordering are in e2e.test.ts
