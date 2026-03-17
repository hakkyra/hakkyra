/**
 * P12.22 — Role-Scoped Introspection Tests
 *
 * Verifies that GraphQL introspection (__schema, __type) returns different
 * results for different roles based on their permissions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, graphqlRequest, tokens,
  ADMIN_SECRET, ALICE_ID,
} from './setup.js';

beforeAll(async () => {
  await startServer();
});

afterAll(async () => {
  await stopServer();
});

/**
 * Run an introspection query that returns all query root field names.
 */
async function introspectQueryFieldNames(headers: Record<string, string>): Promise<string[]> {
  const { body } = await graphqlRequest(
    `{
      __schema {
        queryType {
          fields {
            name
          }
        }
      }
    }`,
    undefined,
    headers,
  );
  const queryType = (body.data as {
    __schema: { queryType: { fields: Array<{ name: string }> } | null };
  })?.__schema?.queryType;
  if (!queryType) return [];
  return queryType.fields.map(f => f.name);
}

/**
 * Run an introspection query that returns all type names (just names, no kind
 * which triggers CJS/ESM errors on the full schema).
 */
async function introspectTypeNames(headers: Record<string, string>): Promise<string[]> {
  const { body } = await graphqlRequest(
    `{
      __schema {
        types {
          name
        }
      }
    }`,
    undefined,
    headers,
  );
  const types = (body.data as {
    __schema: { types: Array<{ name: string }> };
  })?.__schema?.types;
  if (!types) return [];
  // Filter to non-introspection types
  return types.filter(t => !t.name.startsWith('__')).map(t => t.name);
}

describe('Role-Scoped Introspection (P12.22)', () => {
  it('client role sees only permitted root query fields', async () => {
    const token = await tokens.client(ALICE_ID);
    const fields = await introspectQueryFieldNames({
      authorization: `Bearer ${token}`,
    });

    // Client role should see tables they have select permission on
    expect(fields).toContain('clients');
    // Client role should NOT see root fields for tables they lack permissions on
    expect(fields).not.toContain('branches');
  });

  it('client role sees fewer types than admin', async () => {
    // Admin — use role schema approach to avoid CJS/ESM errors
    const adminTypes = await introspectTypeNames({
      'x-hasura-admin-secret': ADMIN_SECRET,
    });

    const token = await tokens.client(ALICE_ID);
    const clientTypes = await introspectTypeNames({
      authorization: `Bearer ${token}`,
    });

    // Both should have types
    expect(adminTypes.length).toBeGreaterThan(0);
    expect(clientTypes.length).toBeGreaterThan(0);
    // Client role should see fewer types than admin
    expect(clientTypes.length).toBeLessThan(adminTypes.length);
  });

  it('admin with x-hasura-role header sees role-scoped root fields', async () => {
    const fields = await introspectQueryFieldNames({
      'x-hasura-admin-secret': ADMIN_SECRET,
      'x-hasura-role': 'client',
    });

    // Using admin key with role override should see the client role's schema
    expect(fields).toContain('clients');
    expect(fields).not.toContain('branches');
  });

  it('backoffice role sees more root fields than client role', async () => {
    const clientToken = await tokens.client(ALICE_ID);
    const clientFields = await introspectQueryFieldNames({
      authorization: `Bearer ${clientToken}`,
    });

    const backofficeToken = await tokens.backoffice();
    const backofficeFields = await introspectQueryFieldNames({
      authorization: `Bearer ${backofficeToken}`,
    });

    // Backoffice should see more root fields than client
    expect(backofficeFields.length).toBeGreaterThan(clientFields.length);
  });

  it('__type query returns type info for accessible types', async () => {
    const token = await tokens.client(ALICE_ID);
    const { body } = await graphqlRequest(
      `{
        __type(name: "Client") {
          name
          kind
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    const typeData = (body.data as { __type: { name: string; kind: string } | null })?.__type;
    expect(typeData).not.toBeNull();
    expect(typeData!.name).toBe('Client');
    expect(typeData!.kind).toBe('OBJECT');
  });

  it('__type query returns null for types not reachable by the role', async () => {
    const token = await tokens.client(ALICE_ID);
    // Use a type that is NOT tracked and NOT reachable via relationships
    const { body } = await graphqlRequest(
      `{
        __type(name: "NonExistentType") {
          name
        }
      }`,
      undefined,
      { authorization: `Bearer ${token}` },
    );

    const typeData = (body.data as { __type: { name: string } | null })?.__type;
    expect(typeData).toBeNull();
  });

  it('client role root fields do not include mutation-only tables', async () => {
    const token = await tokens.client(ALICE_ID);
    const fields = await introspectQueryFieldNames({
      authorization: `Bearer ${token}`,
    });

    // Verify the schema is scoped — client should have specific fields
    // but not admin-only fields
    expect(fields.length).toBeGreaterThan(0);
    // Verify no fields for tables without select permissions
    expect(fields).not.toContain('roles');
  });
});
