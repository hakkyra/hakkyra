/**
 * P13.18 — A trailing `;` in native query code breaks every wrapped query.
 *
 * `applyStringifyProjection` and the permission filter both inline the native
 * query SQL as a subquery (`SELECT ... FROM (<sql>) AS ...`). A statement
 * terminator inside the parentheses is a PG syntax error. Hasura accepts a
 * trailing `;` (normal when the SQL was pasted out of psql), so
 * `parseNativeQuerySQL` — the single choke point shared by the resolver and
 * the subscription path — must strip trailing whitespace and semicolons.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseNativeQuerySQL, applyStringifyProjection } from '../src/schema/native-queries.js';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';
import type { LogicalModel } from '../src/types.js';
import { waitForDb, getPool, closePool } from './setup.js';

describe('parseNativeQuerySQL: trailing semicolon', () => {
  it('strips a trailing semicolon', () => {
    const { sql } = parseNativeQuerySQL('SELECT 1 AS one;');
    expect(sql).toBe('SELECT 1 AS one');
  });

  it('strips trailing whitespace and semicolons in any order', () => {
    const { sql } = parseNativeQuerySQL('SELECT 1 AS one ; \n ;\n');
    expect(sql).toBe('SELECT 1 AS one');
  });

  it('still parses {{param}} placeholders when code ends with a semicolon', () => {
    const { sql, paramNames } = parseNativeQuerySQL(
      'SELECT * FROM client WHERE branch_id = {{branchId}};\n',
    );
    expect(sql).toBe('SELECT * FROM client WHERE branch_id = $1');
    expect(paramNames).toEqual(['branchId']);
  });

  it('does not touch semicolons inside the statement', () => {
    const { sql } = parseNativeQuerySQL(`SELECT ';' AS sep;`);
    expect(sql).toBe(`SELECT ';' AS sep`);
  });
});

describe('wrapped native query executes against PG', () => {
  beforeAll(async () => {
    await waitForDb();
  });

  afterAll(async () => {
    configureStringifyNumericTypes(false);
    await closePool();
  });

  const model: LogicalModel = {
    name: 'CountResult',
    fields: [{ name: 'count', type: 'bigint', nullable: false }],
    selectPermissions: [],
  };

  it('stringify projection wrap survives a trailing semicolon in code', async () => {
    configureStringifyNumericTypes(true);
    const { sql } = parseNativeQuerySQL('SELECT count(*)::bigint AS "count" FROM client;');
    const wrapped = applyStringifyProjection(sql, model);
    expect(wrapped).toContain('__nq_str'); // the wrap actually happened
    const result = await getPool().query(wrapped);
    expect(typeof result.rows[0].count).toBe('string');
  });

  it('permission filter wrap survives a trailing semicolon in code', async () => {
    configureStringifyNumericTypes(false);
    const { sql } = parseNativeQuerySQL('SELECT count(*)::bigint AS "count" FROM client;');
    const wrapped = `SELECT * FROM (${sql}) AS __nq WHERE "count" >= 0`;
    const result = await getPool().query(wrapped);
    expect(result.rows).toHaveLength(1);
  });
});
