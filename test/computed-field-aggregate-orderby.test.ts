/**
 * Tests for P12.16 — Missing AggregateOrderBy types for SETOF computed field
 * array relationships.
 *
 * When a table has a SETOF computed field returning a tracked table, the parent
 * table's OrderBy type should include a `{cfName}Aggregate` field pointing to
 * the return table's AggregateOrderBy type. This allows ordering parent rows
 * by aggregate values of the computed field array relationship.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLSchema,
  GraphQLInputObjectType,
} from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel } from '../src/types.js';
import {
  getPool, closePool, waitForDb,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
} from './setup.js';

let schema: GraphQLSchema;
let schemaModel: SchemaModel;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  resetComparisonTypeCache();

  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  schema = generateSchema(schemaModel);
});

afterAll(async () => {
  await closePool();
});

// ── P12.16: AggregateOrderBy for SETOF computed fields ──────────────────────

describe('P12.16 — SETOF computed field AggregateOrderBy in parent OrderBy', () => {
  it('ClientOrderBy should have activeAccountsAggregate field', () => {
    const clientOrderBy = schema.getType('ClientOrderBy') as GraphQLInputObjectType | undefined;
    expect(clientOrderBy).toBeDefined();
    const fields = clientOrderBy!.getFields();
    expect(fields['activeAccountsAggregate']).toBeDefined();
  });

  it('activeAccountsAggregate should reference AccountAggregateOrderBy', () => {
    const clientOrderBy = schema.getType('ClientOrderBy') as GraphQLInputObjectType;
    const aggField = clientOrderBy.getFields()['activeAccountsAggregate'];
    expect(aggField).toBeDefined();
    expect(aggField.type.toString()).toBe('AccountAggregateOrderBy');
  });

  it('AccountAggregateOrderBy should have count and per-function fields', () => {
    const aggOrderBy = schema.getType('AccountAggregateOrderBy') as GraphQLInputObjectType | undefined;
    expect(aggOrderBy).toBeDefined();
    const fields = aggOrderBy!.getFields();
    // count is always present
    expect(fields['count']).toBeDefined();
    // Account has numeric columns (balance, credit_balance, pending_balance),
    // so avg/sum/etc. should be present
    expect(fields['avg']).toBeDefined();
    expect(fields['sum']).toBeDefined();
    expect(fields['max']).toBeDefined();
    expect(fields['min']).toBeDefined();
  });

  it('ClientOrderBy should NOT have scalar computed fields as aggregate', () => {
    // Scalar computed fields like totalBalance should NOT get an aggregate entry
    const clientOrderBy = schema.getType('ClientOrderBy') as GraphQLInputObjectType;
    const fields = clientOrderBy.getFields();
    // totalBalance is a scalar computed field — should have direct OrderBy, not aggregate
    expect(fields['totalBalance']).toBeDefined();
    expect(fields['totalBalanceAggregate']).toBeUndefined();
  });

  it('regular array relationships still have aggregate ordering', () => {
    // Sanity check: the existing accounts array relationship should still work
    const clientOrderBy = schema.getType('ClientOrderBy') as GraphQLInputObjectType;
    const fields = clientOrderBy.getFields();
    expect(fields['accountsAggregate']).toBeDefined();
    expect(fields['accountsAggregate'].type.toString()).toBe('AccountAggregateOrderBy');
  });
});
