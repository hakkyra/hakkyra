/**
 * Tests for nested relationships in mutation RETURNING clauses.
 *
 * Verifies that INSERT, UPDATE, and DELETE mutations can return nested
 * relationship data (both object and array relationships) in the RETURNING
 * clause, just like SELECT queries do.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { compileInsertOne, compileInsert } from '../src/sql/insert.js';
import { compileUpdateByPk, compileUpdate } from '../src/sql/update.js';
import { compileDeleteByPk, compileDelete } from '../src/sql/delete.js';
import { compileFilter } from '../src/permissions/compiler.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { BoolExp, SchemaModel, TableInfo } from '../src/types.js';
import type { RelationshipSelection } from '../src/sql/select.js';
import {
  getPool, closePool, waitForDb, makeSession,
  METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL,
  ALICE_ID, BOB_ID, BRANCH_TEST_ID,
  startServer, stopServer, graphqlRequest, tokens,
  ADMIN_SECRET,
} from './setup.js';

let schemaModel: SchemaModel;

function findTable(name: string): TableInfo {
  const table = schemaModel.tables.find((t) => t.name === name);
  if (!table) throw new Error(`Table ${name} not found in schema model`);
  return table;
}

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

// ─── SQL Compiler Tests ─────────────────────────────────────────────────────

describe('INSERT with returning relationships (SQL)', () => {
  const adminSession = makeSession('admin');

  it('should compile INSERT ONE with object relationship in RETURNING', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const branchTable = findTable('branch');
    const branchRel = clientTable.relationships.find((r) => r.name === 'branch')!;
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee10';

    const relSelection: RelationshipSelection = {
      relationship: branchRel,
      remoteTable: branchTable,
      columns: ['id', 'name', 'code'],
    };

    const query = compileInsertOne({
      table: clientTable,
      object: {
        id: newId,
        username: 'test_insert_rel_user',
        email: 'insertrel@test.com',
        branch_id: BRANCH_TEST_ID,
        currency_id: 'EUR',
        status: 'active',
      },
      returningColumns: ['id', 'username'],
      returningRelationships: [relSelection],
      session: adminSession,
    });

    // Should use CTE pattern and include relationship subquery
    expect(query.sql).toContain('WITH "_inserted" AS');
    expect(query.sql).toContain('json_build_object');
    expect(query.sql).toContain('branch');

    try {
      // Execute and verify
      const result = await pool.query(query.sql, query.params);
      expect(result.rows).toHaveLength(1);
      const data = result.rows[0].data;
      expect(data.id).toBe(newId);
      expect(data.username).toBe('test_insert_rel_user');
      expect(data.branch).toBeDefined();
      expect(data.branch.name).toBe('TestBranch');
      expect(data.branch.code).toBe('MAIN');
    } finally {
      // Cleanup
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });

  it('should compile INSERT ONE with array relationship in RETURNING', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const accountTable = findTable('account');
    const accountsRel = clientTable.relationships.find((r) => r.name === 'accounts')!;
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee11';

    const relSelection: RelationshipSelection = {
      relationship: accountsRel,
      remoteTable: accountTable,
      columns: ['id', 'balance', 'currency_id'],
    };

    const query = compileInsertOne({
      table: clientTable,
      object: {
        id: newId,
        username: 'test_insert_arr_user',
        email: 'insertarr@test.com',
        branch_id: BRANCH_TEST_ID,
        currency_id: 'EUR',
        status: 'active',
      },
      returningColumns: ['id', 'username'],
      returningRelationships: [relSelection],
      session: adminSession,
    });

    try {
      const result = await pool.query(query.sql, query.params);
      expect(result.rows).toHaveLength(1);
      const data = result.rows[0].data;
      expect(data.id).toBe(newId);
      // New user has no accounts yet
      expect(data.accounts).toBeDefined();
      expect(Array.isArray(data.accounts)).toBe(true);
      expect(data.accounts).toHaveLength(0);
    } finally {
      // Cleanup
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });

  it('should compile bulk INSERT with relationship in RETURNING', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const branchTable = findTable('branch');
    const branchRel = clientTable.relationships.find((r) => r.name === 'branch')!;
    const ids = [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee12',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee13',
    ];

    const relSelection: RelationshipSelection = {
      relationship: branchRel,
      remoteTable: branchTable,
      columns: ['id', 'name'],
    };

    const query = compileInsert({
      table: clientTable,
      objects: [
        { id: ids[0], username: 'bulk_rel_1', email: 'bulk1@test.com', branch_id: BRANCH_TEST_ID, currency_id: 'EUR', status: 'active' },
        { id: ids[1], username: 'bulk_rel_2', email: 'bulk2@test.com', branch_id: BRANCH_TEST_ID, currency_id: 'USD', status: 'active' },
      ],
      returningColumns: ['id', 'username'],
      returningRelationships: [relSelection],
      session: adminSession,
    });

    // Should use CTE pattern with json_agg
    expect(query.sql).toContain('WITH "_inserted" AS');
    expect(query.sql).toContain('json_agg');

    try {
      const result = await pool.query(query.sql, query.params);
      expect(result.rows).toHaveLength(1);
      const data = result.rows[0].data;
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
      expect(data[0].branch).toBeDefined();
      expect(data[0].branch.name).toBe('TestBranch');
      expect(data[1].branch).toBeDefined();
    } finally {
      // Cleanup
      await pool.query('DELETE FROM client WHERE id = ANY($1)', [ids]).catch(() => {});
    }
  });
});

describe('UPDATE with returning relationships (SQL)', () => {
  const adminSession = makeSession('admin');

  it('should compile UPDATE BY PK with object relationship in RETURNING', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const branchTable = findTable('branch');
    const branchRel = clientTable.relationships.find((r) => r.name === 'branch')!;

    const relSelection: RelationshipSelection = {
      relationship: branchRel,
      remoteTable: branchTable,
      columns: ['id', 'name', 'code'],
    };

    const query = compileUpdateByPk({
      table: clientTable,
      pkValues: { id: ALICE_ID },
      _set: { trust_level: 99 },
      returningColumns: ['id', 'username', 'trust_level'],
      returningRelationships: [relSelection],
      session: adminSession,
    });

    // Should use CTE pattern
    expect(query.sql).toContain('WITH "_updated" AS');
    expect(query.sql).toContain('branch');

    try {
      const result = await pool.query(query.sql, query.params);
      expect(result.rows).toHaveLength(1);
      const data = result.rows[0].data;
      expect(data.id).toBe(ALICE_ID);
      expect(data.trustLevel).toBe(99);
      expect(data.branch).toBeDefined();
      expect(data.branch.name).toBe('TestBranch');
    } finally {
      // Reset
      await pool.query('UPDATE client SET trust_level = 2 WHERE id = $1', [ALICE_ID]);
    }
  });

  it('should compile bulk UPDATE with array relationship in RETURNING', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const accountTable = findTable('account');
    const accountsRel = clientTable.relationships.find((r) => r.name === 'accounts')!;

    const relSelection: RelationshipSelection = {
      relationship: accountsRel,
      remoteTable: accountTable,
      columns: ['id', 'balance'],
    };

    const query = compileUpdate({
      table: clientTable,
      where: { id: { _eq: ALICE_ID } } as BoolExp,
      _set: { trust_level: 50 },
      returningColumns: ['id', 'username'],
      returningRelationships: [relSelection],
      session: adminSession,
    });

    // Should use CTE pattern with json_agg
    expect(query.sql).toContain('WITH "_updated" AS');
    expect(query.sql).toContain('json_agg');

    try {
      const result = await pool.query(query.sql, query.params);
      expect(result.rows).toHaveLength(1);
      const data = result.rows[0].data;
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].accounts).toBeDefined();
      expect(Array.isArray(data[0].accounts)).toBe(true);
      expect(data[0].accounts.length).toBeGreaterThan(0);
    } finally {
      // Reset
      await pool.query('UPDATE client SET trust_level = 2 WHERE id = $1', [ALICE_ID]);
    }
  });
});

describe('DELETE with returning relationships (SQL)', () => {
  const adminSession = makeSession('admin');

  it('should compile DELETE BY PK with object relationship in RETURNING', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const branchTable = findTable('branch');
    const branchRel = clientTable.relationships.find((r) => r.name === 'branch')!;
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee20';

    // Insert a test row first
    await pool.query(
      `INSERT INTO client (id, username, email, branch_id, currency_id, status) VALUES ($1, 'del_rel_test', 'delrel@test.com', $2, 'EUR', 'active')`,
      [newId, BRANCH_TEST_ID],
    );

    try {
      const relSelection: RelationshipSelection = {
        relationship: branchRel,
        remoteTable: branchTable,
        columns: ['id', 'name'],
      };

      const query = compileDeleteByPk({
        table: clientTable,
        pkValues: { id: newId },
        returningColumns: ['id', 'username'],
        returningRelationships: [relSelection],
        session: adminSession,
      });

      // Should use CTE pattern
      expect(query.sql).toContain('WITH "_deleted" AS');

      const result = await pool.query(query.sql, query.params);
      expect(result.rows).toHaveLength(1);
      const data = result.rows[0].data;
      expect(data.id).toBe(newId);
      expect(data.username).toBe('del_rel_test');
      // Branch still exists after deleting the client
      expect(data.branch).toBeDefined();
      expect(data.branch.name).toBe('TestBranch');
    } finally {
      // Cleanup in case the delete query didn't execute
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });

  it('should compile bulk DELETE with relationship in RETURNING', async () => {
    const pool = getPool();
    const currencyTable = findTable('currency');

    // Currency has no relationships defined in our test schema, but we can
    // verify the CTE pattern works even with empty relationship subqueries.
    // Instead, test with client_data which has a relationship to client.
    const clientDataTable = findTable('client_data');
    const clientTable = findTable('client');
    const clientRel = clientDataTable.relationships.find((r) => r.name === 'client')!;

    // If there is no 'client' relationship, skip (depends on metadata config)
    if (!clientRel) {
      return;
    }

    const relSelection: RelationshipSelection = {
      relationship: clientRel,
      remoteTable: clientTable,
      columns: ['id', 'username'],
    };

    // Insert test data
    const testDataId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee21';
    await pool.query(
      `INSERT INTO client_data (id, client_id, key, value) VALUES ($1, $2, 'test_del_rel', '"test"')`,
      [testDataId, ALICE_ID],
    );

    try {
      const query = compileDelete({
        table: clientDataTable,
        where: { id: { _eq: testDataId } } as BoolExp,
        returningColumns: ['id', 'key'],
        returningRelationships: [relSelection],
        session: adminSession,
      });

      expect(query.sql).toContain('WITH "_deleted" AS');

      const result = await pool.query(query.sql, query.params);
      expect(result.rows).toHaveLength(1);
      const data = result.rows[0].data;
      expect(Array.isArray(data)).toBe(true);
      if (data.length > 0) {
        expect(data[0].id).toBe(testDataId);
        expect(data[0].client).toBeDefined();
        expect(data[0].client.username).toBe('alice');
      }
    } finally {
      // Cleanup in case the delete query didn't execute
      await pool.query('DELETE FROM client_data WHERE id = $1', [testDataId]).catch(() => {});
    }
  });
});

describe('INSERT with nested relationships in RETURNING (SQL)', () => {
  const adminSession = makeSession('admin');

  it('should compile INSERT with nested object + array relationships', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const branchTable = findTable('branch');
    const accountTable = findTable('account');
    const currencyTable = findTable('currency');

    const branchRel = clientTable.relationships.find((r) => r.name === 'branch')!;
    const accountsRel = clientTable.relationships.find((r) => r.name === 'accounts')!;
    const currencyRel = accountTable.relationships.find((r) => r.name === 'currency')!;

    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee30';

    const query = compileInsertOne({
      table: clientTable,
      object: {
        id: newId,
        username: 'test_nested_user',
        email: 'nested@test.com',
        branch_id: BRANCH_TEST_ID,
        currency_id: 'EUR',
        status: 'active',
      },
      returningColumns: ['id', 'username'],
      returningRelationships: [
        {
          relationship: branchRel,
          remoteTable: branchTable,
          columns: ['id', 'name'],
        },
        {
          relationship: accountsRel,
          remoteTable: accountTable,
          columns: ['id', 'balance'],
          relationships: [
            {
              relationship: currencyRel,
              remoteTable: currencyTable,
              columns: ['id', 'name', 'symbol'],
            },
          ],
        },
      ],
      session: adminSession,
    });

    try {
      const result = await pool.query(query.sql, query.params);
      const data = result.rows[0].data;
      expect(data.branch).toBeDefined();
      expect(data.branch.name).toBe('TestBranch');
      expect(data.accounts).toBeDefined();
      expect(Array.isArray(data.accounts)).toBe(true);
      // New user has no accounts, so empty array
      expect(data.accounts).toHaveLength(0);
    } finally {
      // Cleanup
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });
});

describe('Permission filtering on returning relationships (SQL)', () => {
  const clientSession = makeSession('client', ALICE_ID);

  it('should apply permission filter to relationship subqueries in RETURNING', async () => {
    const pool = getPool();
    const clientTable = findTable('client');
    const accountTable = findTable('account');
    const accountsRel = clientTable.relationships.find((r) => r.name === 'accounts')!;

    // Create a permission filter on accounts (only active accounts)
    const accountPermFilter = compileFilter({ active: { _eq: true } } as BoolExp);

    const relSelection: RelationshipSelection = {
      relationship: accountsRel,
      remoteTable: accountTable,
      columns: ['id', 'balance', 'active'],
      permission: {
        filter: accountPermFilter,
        columns: ['id', 'balance', 'active'],
      },
    };

    const query = compileUpdateByPk({
      table: clientTable,
      pkValues: { id: ALICE_ID },
      _set: { trust_level: 5 },
      returningColumns: ['id', 'username'],
      returningRelationships: [relSelection],
      session: clientSession,
    });

    try {
      const result = await pool.query(query.sql, query.params);
      const data = result.rows[0].data;
      expect(data.accounts).toBeDefined();
      // All returned accounts should be active (due to permission filter)
      for (const account of data.accounts) {
        expect(account.active).toBe(true);
      }
    } finally {
      // Reset
      await pool.query('UPDATE client SET trust_level = 2 WHERE id = $1', [ALICE_ID]);
    }
  });
});

// ─── E2E GraphQL Tests ──────────────────────────────────────────────────────

describe('E2E: Returning relationships via GraphQL', () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
  });

  it('insertOne: should return object relationships in the response', async () => {
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee40';
    const pool = getPool();
    try {
      const { body } = await graphqlRequest(
        `mutation {
          insertClient(object: {
            id: "${newId}"
            username: "e2e_insert_rel"
            email: "e2einsertrel@test.com"
            branchId: "${BRANCH_TEST_ID}"
            currencyId: "EUR"
            status: ACTIVE
          }) {
            id
            username
            branch {
              id
              name
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as Record<string, unknown>).insertClient as Record<string, unknown>;
      expect(data.id).toBe(newId);
      expect(data.branch).toBeDefined();
      expect((data.branch as Record<string, unknown>).name).toBe('TestBranch');
    } finally {
      // Cleanup
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });

  it('insertOne: should return array relationships (empty for new row)', async () => {
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee41';
    const pool = getPool();
    try {
      const { body } = await graphqlRequest(
        `mutation {
          insertClient(object: {
            id: "${newId}"
            username: "e2e_insert_arr"
            email: "e2einsertarr@test.com"
            branchId: "${BRANCH_TEST_ID}"
            currencyId: "EUR"
            status: ACTIVE
          }) {
            id
            accounts {
              id
              balance
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as Record<string, unknown>).insertClient as Record<string, unknown>;
      expect(data.accounts).toBeDefined();
      expect(Array.isArray(data.accounts)).toBe(true);
      expect((data.accounts as unknown[]).length).toBe(0);
    } finally {
      // Cleanup
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });

  it('insert (bulk): should return relationships in returning clause', async () => {
    const ids = [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee42',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee43',
    ];
    const pool = getPool();

    try {
      const { body } = await graphqlRequest(
        `mutation {
          insertClients(objects: [
            { id: "${ids[0]}", username: "e2e_bulk_1", email: "bulk1@e2e.com", branchId: "${BRANCH_TEST_ID}", currencyId: "EUR", status: ACTIVE }
            { id: "${ids[1]}", username: "e2e_bulk_2", email: "bulk2@e2e.com", branchId: "${BRANCH_TEST_ID}", currencyId: "USD", status: ACTIVE }
          ]) {
            affectedRows
            returning {
              id
              username
              branch {
                name
              }
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const result = (body.data as Record<string, unknown>).insertClients as Record<string, unknown>;
      expect(result.affectedRows).toBe(2);
      const returning = result.returning as Array<Record<string, unknown>>;
      expect(returning).toHaveLength(2);
      for (const row of returning) {
        expect(row.branch).toBeDefined();
        expect((row.branch as Record<string, unknown>).name).toBe('TestBranch');
      }
    } finally {
      // Cleanup
      await pool.query('DELETE FROM client WHERE id = ANY($1)', [ids]).catch(() => {});
    }
  });

  it('updateByPk: should return relationships with updated data', async () => {
    const pool = getPool();
    try {
      const { body } = await graphqlRequest(
        `mutation {
          updateClientByPk(
            pkColumns: { id: "${ALICE_ID}" }
            _set: { trustLevel: 88 }
          ) {
            id
            username
            trustLevel
            branch {
              id
              name
            }
            accounts {
              id
              balance
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as Record<string, unknown>).updateClientByPk as Record<string, unknown>;
      expect(data.trustLevel).toBe(88);
      expect(data.branch).toBeDefined();
      expect((data.branch as Record<string, unknown>).name).toBe('TestBranch');
      expect(data.accounts).toBeDefined();
      expect(Array.isArray(data.accounts)).toBe(true);
      expect((data.accounts as unknown[]).length).toBeGreaterThan(0);
    } finally {
      // Reset
      await pool.query('UPDATE client SET trust_level = 2 WHERE id = $1', [ALICE_ID]);
    }
  });

  it('update (bulk): should return relationships in returning clause', async () => {
    const pool = getPool();
    try {
      const { body } = await graphqlRequest(
        `mutation {
          updateClients(
            where: { id: { _eq: "${ALICE_ID}" } }
            _set: { trustLevel: 77 }
          ) {
            affectedRows
            returning {
              id
              trustLevel
              branch {
                name
              }
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const result = (body.data as Record<string, unknown>).updateClients as Record<string, unknown>;
      expect(result.affectedRows).toBe(1);
      const returning = result.returning as Array<Record<string, unknown>>;
      expect(returning).toHaveLength(1);
      expect(returning[0].trustLevel).toBe(77);
      expect(returning[0].branch).toBeDefined();
      expect((returning[0].branch as Record<string, unknown>).name).toBe('TestBranch');
    } finally {
      // Reset
      await pool.query('UPDATE client SET trust_level = 2 WHERE id = $1', [ALICE_ID]);
    }
  });

  it('deleteByPk: should return relationships for deleted row', async () => {
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee44';
    const pool = getPool();
    await pool.query(
      `INSERT INTO client (id, username, email, branch_id, currency_id, status) VALUES ($1, 'del_rel_e2e', 'delrele2e@test.com', $2, 'EUR', 'active')`,
      [newId, BRANCH_TEST_ID],
    );

    try {
      const { body } = await graphqlRequest(
        `mutation {
          deleteClientByPk(id: "${newId}") {
            id
            username
            branch {
              name
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const data = (body.data as Record<string, unknown>).deleteClientByPk as Record<string, unknown>;
      expect(data.id).toBe(newId);
      expect(data.branch).toBeDefined();
      expect((data.branch as Record<string, unknown>).name).toBe('TestBranch');
    } finally {
      // Cleanup in case the delete mutation didn't execute
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });

  it('delete (bulk): should return relationships in returning clause', async () => {
    const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee45';
    const pool = getPool();
    await pool.query(
      `INSERT INTO client (id, username, email, branch_id, currency_id, status) VALUES ($1, 'del_bulk_rel', 'delbulkrel@test.com', $2, 'EUR', 'active')`,
      [newId, BRANCH_TEST_ID],
    );

    try {
      const { body } = await graphqlRequest(
        `mutation {
          deleteClients(where: { id: { _eq: "${newId}" } }) {
            affectedRows
            returning {
              id
              branch {
                name
              }
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );

      expect(body.errors).toBeUndefined();
      const result = (body.data as Record<string, unknown>).deleteClients as Record<string, unknown>;
      expect(result.affectedRows).toBe(1);
      const returning = result.returning as Array<Record<string, unknown>>;
      expect(returning).toHaveLength(1);
      expect(returning[0].branch).toBeDefined();
      expect((returning[0].branch as Record<string, unknown>).name).toBe('TestBranch');
    } finally {
      // Cleanup in case the delete mutation didn't execute
      await pool.query('DELETE FROM client WHERE id = $1', [newId]).catch(() => {});
    }
  });
});
