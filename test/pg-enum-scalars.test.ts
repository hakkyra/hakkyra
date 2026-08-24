/**
 * P13.1 — pg_enums_as_scalars (default true).
 *
 * Hasura exposes native PG enum columns as opaque text-like scalars: clients
 * inline string literals (`_set: { status: "active" }`) and read back raw DB
 * values ('draft', not 'DRAFT'). Hakkyra's GraphQL-enum mode remains available
 * via `graphql.pg_enums_as_scalars: false`. Table-based enums (is_enum: true)
 * are real GraphQL enums in both modes — that is Hasura's enum-table feature.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLInputObjectType,
  Kind,
} from 'graphql';
import type { FastifyInstance } from 'fastify';
import { generateSchema } from '../src/schema/generator.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel } from '../src/types.js';
import {
  TEST_DB_URL,
  METADATA_DIR,
  SERVER_CONFIG_PATH,
  ADMIN_SECRET,
  waitForDb,
  getPool,
  closePool,
} from './setup.js';

type AnyRow = Record<string, unknown>;

let schemaModel: SchemaModel;
let server: FastifyInstance;
let serverAddress: string;

async function gql(query: string, variables?: Record<string, unknown>): Promise<{ data?: AnyRow; errors?: Array<{ message: string }> }> {
  const res = await fetch(`${serverAddress}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  return await res.json() as { data?: AnyRow; errors?: Array<{ message: string }> };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  process.env['LOG_LEVEL'] = 'error';
  await waitForDb();

  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  await resolveTableEnums(schemaModel, pool);

  // Boot a server in scalar mode (the default) — the fixture yaml opts out,
  // so flip the loaded config back to the Hasura-compatible default.
  config.graphql.pgEnumsAsScalars = true;
  const { createServer } = await import('../src/server.js');
  server = await createServer(config);
  serverAddress = await server.listen({ port: 0, host: '127.0.0.1' });
}, 30_000);

afterAll(async () => {
  if (server) await server.close();
  await closePool();
});

// ─── Schema-level ────────────────────────────────────────────────────────────

describe('schema generation in scalar mode (default)', () => {
  it('exposes native PG enums as opaque scalars, table enums as real enums', () => {
    resetComparisonTypeCache();
    const schema = generateSchema(schemaModel); // default: scalar mode

    const clientStatus = schema.getType('ClientStatus');
    expect(clientStatus).toBeInstanceOf(GraphQLScalarType);
    const invoiceState = schema.getType('InvoiceState');
    expect(invoiceState).toBeInstanceOf(GraphQLScalarType);

    // Table-based enum (is_enum: true) stays a real GraphQL enum
    const tableEnum = schema.getType('PriorityTypeEnum');
    expect(tableEnum).toBeInstanceOf(GraphQLEnumType);
  });

  it('scalar passes raw values through and accepts string literals', () => {
    resetComparisonTypeCache();
    const schema = generateSchema(schemaModel);
    const scalar = schema.getType('ClientStatus') as GraphQLScalarType;

    expect(scalar.serialize('on_hold')).toBe('on_hold'); // raw, not ON_HOLD
    expect(scalar.parseValue('on_hold')).toBe('on_hold');
    expect(scalar.parseLiteral({ kind: Kind.STRING, value: 'on_hold' } as never, undefined)).toBe('on_hold');
    // ENUM literals accepted for leniency with enum-mode clients
    expect(scalar.parseLiteral({ kind: Kind.ENUM, value: 'on_hold' } as never, undefined)).toBe('on_hold');
    expect(() => scalar.parseLiteral({ kind: Kind.INT, value: '1' } as never, undefined)).toThrow();
  });

  it('generates the comparison exp typed with the scalar', () => {
    resetComparisonTypeCache();
    const schema = generateSchema(schemaModel);
    const cmp = schema.getType('ClientStatusComparisonExp') as GraphQLInputObjectType;
    expect(cmp).toBeDefined();
    const fields = cmp.getFields();
    expect(fields['_eq'].type.toString()).toBe('ClientStatus');
    // native enums keep ordered comparison operators
    expect(fields['_gt']).toBeDefined();
  });

  it('opt-out restores GraphQL enum mode', () => {
    resetComparisonTypeCache();
    const schema = generateSchema(schemaModel, { pgEnumsAsScalars: false });
    expect(schema.getType('ClientStatus')).toBeInstanceOf(GraphQLEnumType);
  });
});

// ─── E2E in scalar mode ──────────────────────────────────────────────────────

describe('E2E: scalar mode', () => {
  it('returns raw lowercase enum values', async () => {
    const body = await gql(`query { clients(limit: 1, where: { status: { _eq: "active" } }) { status } }`);
    expect(body.errors).toBeUndefined();
    const clients = body.data!.clients as AnyRow[];
    expect(clients.length).toBeGreaterThan(0);
    expect(clients[0].status).toBe('active');
  });

  it('accepts inline string literals in _set (the acme break)', async () => {
    const { rows } = await getPool().query(
      `SELECT id FROM invoice WHERE state = 'draft' LIMIT 1`,
    );
    const id = rows[0]?.id as string;
    expect(id).toBeTruthy();

    const body = await gql(`mutation {
      updateInvoiceByPk(pkColumns: { id: "${id}" }, _set: { state: "sent" }) { id state }
    }`);
    expect(body.errors).toBeUndefined();
    const updated = body.data!.updateInvoiceByPk as AnyRow;
    expect(updated.state).toBe('sent');

    // restore
    await getPool().query(`UPDATE invoice SET state = 'draft' WHERE id = $1`, [id]);
  });

  it('accepts enum values through variables as plain strings', async () => {
    const body = await gql(
      `query($s: ClientStatus) { clients(limit: 5, where: { status: { _eq: $s } }) { status } }`,
      { s: 'active' },
    );
    expect(body.errors).toBeUndefined();
    const clients = body.data!.clients as AnyRow[];
    for (const c of clients) expect(c.status).toBe('active');
  });
});
