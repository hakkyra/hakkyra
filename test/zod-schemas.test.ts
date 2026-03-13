import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';

// ─── Raw YAML schemas (src/config/schemas.ts) ────────────────────────────────
import {
  RawVersionYamlSchema,
  RawDatabaseEntrySchema,
  RawDatabasesYamlSchema,
  RawTableReferenceSchema,
  RawComputedFieldSchema,
  RawRelationshipSchema,
  RawSelectPermissionSchema,
  RawInsertPermissionSchema,
  RawUpdatePermissionSchema,
  RawDeletePermissionSchema,
  RawSelectPermissionEntrySchema,
  RawInsertPermissionEntrySchema,
  RawUpdatePermissionEntrySchema,
  RawDeletePermissionEntrySchema,
  RawHeaderSchema,
  RawEventTriggerSchema,
  RawTableYamlSchema,
  RawActionSchema,
  RawActionsYamlSchema,
  RawCronTriggerSchema,
  RawRESTOverrideSchema,
  RawCustomQuerySchema,
  RawApiConfigSchema,
  RawServerConfigSchema,
} from '../src/config/schemas.js';

// ─── Internal config schemas (src/config/schemas-internal.ts) ────────────────
import {
  RelationshipTypeSchema,
  RelationshipConfigSchema,
  SelectPermissionSchema,
  InsertPermissionSchema,
  UpdatePermissionSchema,
  DeletePermissionSchema,
  TablePermissionsSchema,
  CustomRootFieldsSchema,
  WebhookHeaderSchema,
  EventTriggerConfigSchema,
  CronTriggerConfigSchema,
  RequestTransformSchema,
  ResponseTransformSchema,
  ActionRelationshipSchema,
  ActionConfigSchema,
  RESTEndpointOverrideSchema,
  RESTConfigSchema,
  CustomQueryConfigSchema,
  APIDocsConfigSchema,
  JobQueueProviderSchema,
  JobQueueConfigSchema,
  AuthConfigSchema,
  RedisConfigSchema,
  PoolConfigSchema,
  DatabasesConfigSchema,
  ComputedFieldConfigSchema,
  HakkyraConfigSchema,
} from '../src/config/schemas-internal.js';

// ─── REST input validation schemas (src/rest/schemas.ts) ─────────────────────
import { MutationBodySchema, PaginationSchema } from '../src/rest/schemas.js';

// =============================================================================
// Helpers
// =============================================================================

/** Parse and expect success, returning parsed data. */
function expectValid<T>(schema: { parse: (d: unknown) => T }, data: unknown): T {
  return schema.parse(data);
}

/** Parse and expect failure, returning the ZodError. */
function expectInvalid(schema: { parse: (d: unknown) => unknown }, data: unknown): ZodError {
  try {
    schema.parse(data);
    throw new Error('Expected schema.parse to throw but it succeeded');
  } catch (err) {
    expect(err).toBeInstanceOf(ZodError);
    return err as ZodError;
  }
}

// =============================================================================
// RAW YAML SCHEMAS
// =============================================================================

describe('Raw YAML Schemas (config/schemas.ts)', () => {
  // ─── RawVersionYamlSchema ──────────────────────────────────────────────────

  describe('RawVersionYamlSchema', () => {
    it('accepts a valid version object', () => {
      const result = expectValid(RawVersionYamlSchema, { version: 3 });
      expect(result.version).toBe(3);
    });

    it('passes through extra fields', () => {
      const result = expectValid(RawVersionYamlSchema, { version: 3, extra: true });
      expect((result as Record<string, unknown>).extra).toBe(true);
    });

    it('rejects missing version', () => {
      const err = expectInvalid(RawVersionYamlSchema, {});
      expect(err.issues[0].path).toEqual(['version']);
    });

    it('rejects non-number version', () => {
      const err = expectInvalid(RawVersionYamlSchema, { version: '3' });
      expect(err.issues[0].path).toEqual(['version']);
      expect(err.issues[0].message).toContain('number');
    });
  });

  // ─── RawDatabaseEntrySchema ────────────────────────────────────────────────

  describe('RawDatabaseEntrySchema', () => {
    const validEntry = {
      name: 'default',
      kind: 'postgres',
      configuration: {
        connection_info: {
          database_url: 'postgresql://localhost/mydb',
        },
      },
      tables: [],
    };

    it('accepts a valid database entry with string URL', () => {
      const result = expectValid(RawDatabaseEntrySchema, validEntry);
      expect(result.name).toBe('default');
    });

    it('accepts database_url as from_env reference', () => {
      const entry = {
        ...validEntry,
        configuration: {
          connection_info: {
            database_url: { from_env: 'DATABASE_URL' },
          },
        },
      };
      expectValid(RawDatabaseEntrySchema, entry);
    });

    it('accepts pool_settings and read_replicas', () => {
      const entry = {
        ...validEntry,
        configuration: {
          connection_info: {
            database_url: 'postgresql://localhost/mydb',
            pool_settings: { max_connections: 10, idle_timeout: 60 },
            use_prepared_statements: true,
          },
          read_replicas: [
            {
              database_url: 'postgresql://localhost/mydb_replica',
              pool_settings: { max_connections: 5 },
            },
          ],
        },
      };
      expectValid(RawDatabaseEntrySchema, entry);
    });

    it('rejects missing name', () => {
      const { name, ...rest } = validEntry;
      const err = expectInvalid(RawDatabaseEntrySchema, rest);
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });

    it('rejects missing configuration', () => {
      const { configuration, ...rest } = validEntry;
      const err = expectInvalid(RawDatabaseEntrySchema, rest);
      expect(err.issues.some((i) => i.path.includes('configuration'))).toBe(true);
    });

    it('rejects non-string/non-from_env database_url', () => {
      const entry = {
        ...validEntry,
        configuration: {
          connection_info: {
            database_url: 12345,
          },
        },
      };
      const err = expectInvalid(RawDatabaseEntrySchema, entry);
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── RawDatabasesYamlSchema ────────────────────────────────────────────────

  describe('RawDatabasesYamlSchema', () => {
    it('accepts empty databases', () => {
      expectValid(RawDatabasesYamlSchema, { databases: [] });
    });

    it('accepts missing databases field (optional)', () => {
      expectValid(RawDatabasesYamlSchema, {});
    });

    it('rejects databases as a non-array', () => {
      const err = expectInvalid(RawDatabasesYamlSchema, { databases: 'nope' });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── RawTableReferenceSchema ───────────────────────────────────────────────

  describe('RawTableReferenceSchema', () => {
    it('accepts a valid table reference', () => {
      const result = expectValid(RawTableReferenceSchema, {
        table: { schema: 'public', name: 'users' },
      });
      expect(result.table.name).toBe('users');
    });

    it('rejects missing table.schema', () => {
      const err = expectInvalid(RawTableReferenceSchema, {
        table: { name: 'users' },
      });
      expect(err.issues.some((i) => i.path.includes('schema'))).toBe(true);
    });

    it('rejects missing table.name', () => {
      const err = expectInvalid(RawTableReferenceSchema, {
        table: { schema: 'public' },
      });
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });
  });

  // ─── RawComputedFieldSchema ────────────────────────────────────────────────

  describe('RawComputedFieldSchema', () => {
    it('accepts a valid computed field', () => {
      const result = expectValid(RawComputedFieldSchema, {
        name: 'full_name',
        definition: {
          function: { name: 'compute_full_name', schema: 'public' },
        },
      });
      expect(result.name).toBe('full_name');
    });

    it('accepts without optional schema in function', () => {
      expectValid(RawComputedFieldSchema, {
        name: 'full_name',
        definition: {
          function: { name: 'compute_full_name' },
        },
      });
    });

    it('accepts optional comment', () => {
      const result = expectValid(RawComputedFieldSchema, {
        name: 'full_name',
        definition: { function: { name: 'compute_full_name' } },
        comment: 'Computes full name',
      });
      expect(result.comment).toBe('Computes full name');
    });

    it('rejects missing name', () => {
      const err = expectInvalid(RawComputedFieldSchema, {
        definition: { function: { name: 'fn' } },
      });
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });

    it('rejects missing definition', () => {
      const err = expectInvalid(RawComputedFieldSchema, { name: 'x' });
      expect(err.issues.some((i) => i.path.includes('definition'))).toBe(true);
    });
  });

  // ─── RawRelationshipSchema ─────────────────────────────────────────────────

  describe('RawRelationshipSchema', () => {
    it('accepts foreign_key_constraint_on as string', () => {
      const result = expectValid(RawRelationshipSchema, {
        name: 'author',
        using: { foreign_key_constraint_on: 'author_id' },
      });
      expect(result.name).toBe('author');
    });

    it('accepts foreign_key_constraint_on as object', () => {
      expectValid(RawRelationshipSchema, {
        name: 'posts',
        using: {
          foreign_key_constraint_on: {
            column: 'author_id',
            table: { schema: 'public', name: 'posts' },
          },
        },
      });
    });

    it('accepts manual_configuration', () => {
      expectValid(RawRelationshipSchema, {
        name: 'category',
        using: {
          manual_configuration: {
            remote_table: { schema: 'public', name: 'categories' },
            column_mapping: { category_id: 'id' },
          },
        },
      });
    });

    it('rejects missing name', () => {
      const err = expectInvalid(RawRelationshipSchema, {
        using: { foreign_key_constraint_on: 'x' },
      });
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });

    it('rejects missing using', () => {
      const err = expectInvalid(RawRelationshipSchema, { name: 'rel' });
      expect(err.issues.some((i) => i.path.includes('using'))).toBe(true);
    });
  });

  // ─── Permission schemas ────────────────────────────────────────────────────

  describe('RawSelectPermissionSchema', () => {
    it('accepts valid select permission with column list', () => {
      const result = expectValid(RawSelectPermissionSchema, {
        columns: ['id', 'name'],
        filter: { id: { _eq: 'X-Hasura-User-Id' } },
      });
      expect(result.columns).toEqual(['id', 'name']);
    });

    it('accepts wildcard columns', () => {
      const result = expectValid(RawSelectPermissionSchema, {
        columns: '*',
        filter: {},
      });
      expect(result.columns).toBe('*');
    });

    it('accepts optional limit and allow_aggregations', () => {
      expectValid(RawSelectPermissionSchema, {
        columns: '*',
        filter: {},
        limit: 100,
        allow_aggregations: true,
        computed_fields: ['total'],
      });
    });

    it('rejects missing columns', () => {
      const err = expectInvalid(RawSelectPermissionSchema, { filter: {} });
      expect(err.issues.some((i) => i.path.includes('columns'))).toBe(true);
    });

    it('rejects missing filter', () => {
      const err = expectInvalid(RawSelectPermissionSchema, { columns: '*' });
      expect(err.issues.some((i) => i.path.includes('filter'))).toBe(true);
    });
  });

  describe('RawInsertPermissionSchema', () => {
    it('accepts valid insert permission', () => {
      expectValid(RawInsertPermissionSchema, {
        columns: ['name', 'email'],
        check: { org_id: { _eq: 'X-Hasura-Org-Id' } },
      });
    });

    it('accepts optional set and backend_only', () => {
      expectValid(RawInsertPermissionSchema, {
        columns: '*',
        check: {},
        set: { created_by: 'X-Hasura-User-Id' },
        backend_only: true,
      });
    });

    it('rejects missing check', () => {
      const err = expectInvalid(RawInsertPermissionSchema, { columns: '*' });
      expect(err.issues.some((i) => i.path.includes('check'))).toBe(true);
    });
  });

  describe('RawUpdatePermissionSchema', () => {
    it('accepts valid update permission', () => {
      expectValid(RawUpdatePermissionSchema, {
        columns: ['name'],
        filter: { id: { _eq: 'X-Hasura-User-Id' } },
      });
    });

    it('accepts optional check and set', () => {
      expectValid(RawUpdatePermissionSchema, {
        columns: '*',
        filter: {},
        check: { status: { _ne: 'archived' } },
        set: { updated_by: 'X-Hasura-User-Id' },
      });
    });

    it('rejects missing filter', () => {
      const err = expectInvalid(RawUpdatePermissionSchema, { columns: '*' });
      expect(err.issues.some((i) => i.path.includes('filter'))).toBe(true);
    });
  });

  describe('RawDeletePermissionSchema', () => {
    it('accepts valid delete permission', () => {
      expectValid(RawDeletePermissionSchema, {
        filter: { owner_id: { _eq: 'X-Hasura-User-Id' } },
      });
    });

    it('rejects missing filter', () => {
      const err = expectInvalid(RawDeletePermissionSchema, {});
      expect(err.issues.some((i) => i.path.includes('filter'))).toBe(true);
    });
  });

  describe('Permission entry schemas', () => {
    it('RawSelectPermissionEntrySchema wraps permission with role', () => {
      expectValid(RawSelectPermissionEntrySchema, {
        role: 'user',
        permission: { columns: '*', filter: {} },
      });
    });

    it('RawInsertPermissionEntrySchema wraps permission with role', () => {
      expectValid(RawInsertPermissionEntrySchema, {
        role: 'user',
        permission: { columns: '*', check: {} },
      });
    });

    it('RawUpdatePermissionEntrySchema wraps permission with role', () => {
      expectValid(RawUpdatePermissionEntrySchema, {
        role: 'user',
        permission: { columns: '*', filter: {} },
      });
    });

    it('RawDeletePermissionEntrySchema wraps permission with role', () => {
      expectValid(RawDeletePermissionEntrySchema, {
        role: 'user',
        permission: { filter: {} },
      });
    });

    it('rejects missing role in permission entry', () => {
      const err = expectInvalid(RawSelectPermissionEntrySchema, {
        permission: { columns: '*', filter: {} },
      });
      expect(err.issues.some((i) => i.path.includes('role'))).toBe(true);
    });

    it('rejects invalid inner permission', () => {
      const err = expectInvalid(RawSelectPermissionEntrySchema, {
        role: 'user',
        permission: { filter: {} }, // missing columns
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── RawHeaderSchema ───────────────────────────────────────────────────────

  describe('RawHeaderSchema', () => {
    it('accepts header with value', () => {
      expectValid(RawHeaderSchema, { name: 'Authorization', value: 'Bearer xxx' });
    });

    it('accepts header with value_from_env', () => {
      expectValid(RawHeaderSchema, { name: 'X-API-Key', value_from_env: 'API_KEY' });
    });

    it('rejects missing name', () => {
      const err = expectInvalid(RawHeaderSchema, { value: 'test' });
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });
  });

  // ─── RawEventTriggerSchema ─────────────────────────────────────────────────

  describe('RawEventTriggerSchema', () => {
    const validTrigger = {
      name: 'on_user_insert',
      definition: {
        insert: { columns: '*' },
        enable_manual: false,
      },
      retry_conf: {
        interval_sec: 10,
        num_retries: 3,
        timeout_sec: 60,
      },
      webhook: 'https://example.com/hook',
    };

    it('accepts a valid event trigger', () => {
      const result = expectValid(RawEventTriggerSchema, validTrigger);
      expect(result.name).toBe('on_user_insert');
    });

    it('accepts webhook_from_env instead of webhook', () => {
      const { webhook, ...rest } = validTrigger;
      expectValid(RawEventTriggerSchema, { ...rest, webhook_from_env: 'WEBHOOK_URL' });
    });

    it('accepts optional headers', () => {
      expectValid(RawEventTriggerSchema, {
        ...validTrigger,
        headers: [{ name: 'X-Key', value: 'val' }],
      });
    });

    it('rejects missing name', () => {
      const { name, ...rest } = validTrigger;
      const err = expectInvalid(RawEventTriggerSchema, rest);
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });

    it('rejects missing definition', () => {
      const { definition, ...rest } = validTrigger;
      const err = expectInvalid(RawEventTriggerSchema, rest);
      expect(err.issues.some((i) => i.path.includes('definition'))).toBe(true);
    });

    it('rejects missing retry_conf', () => {
      const { retry_conf, ...rest } = validTrigger;
      const err = expectInvalid(RawEventTriggerSchema, rest);
      expect(err.issues.some((i) => i.path.includes('retry_conf'))).toBe(true);
    });
  });

  // ─── RawTableYamlSchema ────────────────────────────────────────────────────

  describe('RawTableYamlSchema', () => {
    it('accepts a minimal table definition', () => {
      const result = expectValid(RawTableYamlSchema, {
        table: { schema: 'public', name: 'users' },
      });
      expect(result.table.name).toBe('users');
    });

    it('accepts a full table with all optional fields', () => {
      expectValid(RawTableYamlSchema, {
        table: { schema: 'public', name: 'users' },
        configuration: {
          custom_root_fields: { select: 'allUsers' },
          custom_column_names: { first_name: 'firstName' },
        },
        object_relationships: [
          { name: 'profile', using: { foreign_key_constraint_on: 'profile_id' } },
        ],
        array_relationships: [
          {
            name: 'posts',
            using: {
              foreign_key_constraint_on: {
                column: 'author_id',
                table: { schema: 'public', name: 'posts' },
              },
            },
          },
        ],
        computed_fields: [
          { name: 'full_name', definition: { function: { name: 'fn_full_name' } } },
        ],
        select_permissions: [{ role: 'user', permission: { columns: '*', filter: {} } }],
        insert_permissions: [{ role: 'user', permission: { columns: '*', check: {} } }],
        update_permissions: [{ role: 'user', permission: { columns: '*', filter: {} } }],
        delete_permissions: [{ role: 'admin', permission: { filter: {} } }],
        event_triggers: [
          {
            name: 'on_insert',
            definition: { insert: { columns: '*' } },
            retry_conf: { interval_sec: 10, num_retries: 3, timeout_sec: 60 },
            webhook: 'https://example.com/hook',
          },
        ],
      });
    });

    it('rejects missing table field', () => {
      const err = expectInvalid(RawTableYamlSchema, {});
      expect(err.issues.some((i) => i.path.includes('table'))).toBe(true);
    });

    it('rejects table without schema', () => {
      const err = expectInvalid(RawTableYamlSchema, {
        table: { name: 'users' },
      });
      expect(err.issues.some((i) => i.path.includes('schema'))).toBe(true);
    });
  });

  // ─── RawActionSchema ──────────────────────────────────────────────────────

  describe('RawActionSchema', () => {
    const validAction = {
      name: 'createUser',
      definition: {
        kind: 'synchronous' as const,
        handler: 'https://actions.example.com/createUser',
        type: 'mutation',
        output_type: 'CreateUserOutput',
      },
    };

    it('accepts a valid action', () => {
      const result = expectValid(RawActionSchema, validAction);
      expect(result.name).toBe('createUser');
    });

    it('accepts action with permissions and relationships', () => {
      expectValid(RawActionSchema, {
        ...validAction,
        permissions: [{ role: 'user' }, { role: 'admin' }],
        relationships: [
          {
            name: 'user',
            type: 'object',
            remote_table: { schema: 'public', name: 'users' },
            field_mapping: { user_id: 'id' },
          },
        ],
        comment: 'Creates a new user',
      });
    });

    it('accepts action with request/response transforms', () => {
      expectValid(RawActionSchema, {
        ...validAction,
        definition: {
          ...validAction.definition,
          request_transform: { method: 'POST', url: '/create' },
          response_transform: { body: '{{ $body.result }}' },
        },
      });
    });

    it('rejects missing name', () => {
      const { name, ...rest } = validAction;
      const err = expectInvalid(RawActionSchema, rest);
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });

    it('rejects missing definition', () => {
      const err = expectInvalid(RawActionSchema, { name: 'x' });
      expect(err.issues.some((i) => i.path.includes('definition'))).toBe(true);
    });

    it('rejects invalid kind enum value', () => {
      const err = expectInvalid(RawActionSchema, {
        ...validAction,
        definition: { ...validAction.definition, kind: 'invalid' },
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects invalid relationship type', () => {
      const err = expectInvalid(RawActionSchema, {
        ...validAction,
        relationships: [
          {
            name: 'user',
            type: 'invalid',
            remote_table: 'users',
            field_mapping: { user_id: 'id' },
          },
        ],
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── RawActionsYamlSchema ──────────────────────────────────────────────────

  describe('RawActionsYamlSchema', () => {
    it('accepts empty actions', () => {
      expectValid(RawActionsYamlSchema, { actions: [] });
    });

    it('accepts with custom_types', () => {
      expectValid(RawActionsYamlSchema, {
        actions: [],
        custom_types: { objects: [] },
      });
    });

    it('accepts empty object (all fields optional)', () => {
      expectValid(RawActionsYamlSchema, {});
    });
  });

  // ─── RawCronTriggerSchema ──────────────────────────────────────────────────

  describe('RawCronTriggerSchema', () => {
    const validCron = {
      name: 'daily_cleanup',
      schedule: '0 0 * * *',
      webhook: 'https://example.com/cleanup',
    };

    it('accepts a valid cron trigger', () => {
      const result = expectValid(RawCronTriggerSchema, validCron);
      expect(result.name).toBe('daily_cleanup');
      expect(result.schedule).toBe('0 0 * * *');
    });

    it('accepts all optional fields', () => {
      expectValid(RawCronTriggerSchema, {
        ...validCron,
        payload: { key: 'value' },
        retry_conf: { num_retries: 3, retry_interval_seconds: 10, timeout_seconds: 60 },
        headers: [{ name: 'X-Key', value: 'val' }],
        include_in_metadata: true,
        comment: 'Clean up old data',
      });
    });

    it('rejects missing schedule', () => {
      const { schedule, ...rest } = validCron;
      const err = expectInvalid(RawCronTriggerSchema, rest);
      expect(err.issues.some((i) => i.path.includes('schedule'))).toBe(true);
    });

    it('rejects missing name', () => {
      const { name, ...rest } = validCron;
      const err = expectInvalid(RawCronTriggerSchema, rest);
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });
  });

  // ─── RawRESTOverrideSchema ─────────────────────────────────────────────────

  describe('RawRESTOverrideSchema', () => {
    it('accepts a valid REST override', () => {
      expectValid(RawRESTOverrideSchema, {
        method: 'GET',
        path: '/users',
        operation: 'select',
      });
    });

    it('accepts all valid HTTP methods', () => {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        expectValid(RawRESTOverrideSchema, {
          method,
          path: '/test',
          operation: 'select',
        });
      }
    });

    it('rejects invalid HTTP method', () => {
      const err = expectInvalid(RawRESTOverrideSchema, {
        method: 'OPTIONS',
        path: '/test',
        operation: 'select',
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects missing path', () => {
      const err = expectInvalid(RawRESTOverrideSchema, {
        method: 'GET',
        operation: 'select',
      });
      expect(err.issues.some((i) => i.path.includes('path'))).toBe(true);
    });

    it('rejects missing operation', () => {
      const err = expectInvalid(RawRESTOverrideSchema, {
        method: 'GET',
        path: '/test',
      });
      expect(err.issues.some((i) => i.path.includes('operation'))).toBe(true);
    });
  });

  // ─── RawCustomQuerySchema ──────────────────────────────────────────────────

  describe('RawCustomQuerySchema', () => {
    const validQuery = {
      name: 'get_stats',
      type: 'query' as const,
      sql: 'SELECT count(*) FROM users',
      returns: 'StatsResult',
    };

    it('accepts a valid custom query', () => {
      const result = expectValid(RawCustomQuerySchema, validQuery);
      expect(result.name).toBe('get_stats');
    });

    it('accepts mutation type', () => {
      expectValid(RawCustomQuerySchema, { ...validQuery, type: 'mutation' });
    });

    it('accepts optional params and permissions', () => {
      expectValid(RawCustomQuerySchema, {
        ...validQuery,
        params: [{ name: 'org_id', type: 'uuid' }],
        permissions: [{ role: 'admin' }],
      });
    });

    it('rejects invalid type enum', () => {
      const err = expectInvalid(RawCustomQuerySchema, { ...validQuery, type: 'subscription' });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects missing sql', () => {
      const { sql, ...rest } = validQuery;
      const err = expectInvalid(RawCustomQuerySchema, rest);
      expect(err.issues.some((i) => i.path.includes('sql'))).toBe(true);
    });

    it('rejects missing returns', () => {
      const { returns, ...rest } = validQuery;
      const err = expectInvalid(RawCustomQuerySchema, rest);
      expect(err.issues.some((i) => i.path.includes('returns'))).toBe(true);
    });
  });

  // ─── RawApiConfigSchema ────────────────────────────────────────────────────

  describe('RawApiConfigSchema', () => {
    it('accepts empty object (all fields optional)', () => {
      expectValid(RawApiConfigSchema, {});
    });

    it('accepts full api config', () => {
      expectValid(RawApiConfigSchema, {
        table_aliases: { users: 'people' },
        custom_queries: [
          { name: 'q', type: 'query', sql: 'SELECT 1', returns: 'Result' },
        ],
        rest: {
          auto_generate: true,
          base_path: '/api/v1',
          pagination: { default_limit: 20, max_limit: 100 },
          overrides: {
            users: [{ method: 'GET', path: '/users', operation: 'select' }],
          },
        },
        docs: {
          generate: true,
          output: './docs',
          llm_format: true,
          include_examples: true,
        },
      });
    });

    it('rejects non-object table_aliases', () => {
      const err = expectInvalid(RawApiConfigSchema, { table_aliases: 'nope' });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── RawServerConfigSchema ─────────────────────────────────────────────────

  describe('RawServerConfigSchema', () => {
    it('accepts empty object (all sections optional)', () => {
      expectValid(RawServerConfigSchema, {});
    });

    it('accepts full server config', () => {
      expectValid(RawServerConfigSchema, {
        server: { port: 8080, host: '0.0.0.0', slow_query_threshold_ms: 500 },
        job_queue: {
          provider: 'pg-boss',
          connection_string: 'postgresql://localhost/jobs',
        },
        event_log: { retention_days: 30 },
        auth: {
          jwt: {
            type: 'HS256',
            key: 'secret-key-minimum-32-characters!',
            claims_namespace: 'https://hasura.io/jwt/claims',
          },
          admin_secret_from_env: 'ADMIN_SECRET',
          unauthorized_role: 'anonymous',
        },
        databases: {
          primary: { url_from_env: 'DATABASE_URL', pool: { max: 10 } },
          replicas: [{ url_from_env: 'REPLICA_URL' }],
          read_your_writes: { enabled: true, window_seconds: 5 },
          prepared_statements: { enabled: true, max_cached: 100 },
        },
      });
    });

    it('accepts bullmq provider with redis config', () => {
      expectValid(RawServerConfigSchema, {
        job_queue: {
          provider: 'bullmq',
          redis: { host: 'localhost', port: 6379, password: 'secret' },
        },
      });
    });

    it('rejects invalid job_queue provider', () => {
      const err = expectInvalid(RawServerConfigSchema, {
        job_queue: { provider: 'sidekiq' },
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects non-number port', () => {
      const err = expectInvalid(RawServerConfigSchema, {
        server: { port: '8080' },
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('accepts auth webhook config', () => {
      expectValid(RawServerConfigSchema, {
        auth: {
          webhook: {
            url: 'https://auth.example.com/verify',
            mode: 'POST',
            forward_headers: true,
          },
        },
      });
    });

    it('rejects invalid auth webhook mode', () => {
      const err = expectInvalid(RawServerConfigSchema, {
        auth: {
          webhook: { url: 'http://test.com', mode: 'PATCH' },
        },
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('accepts databases with session config', () => {
      expectValid(RawServerConfigSchema, {
        databases: {
          primary: { url_from_env: 'DATABASE_URL' },
          session: { url_from_env: 'DATABASE_SESSION_URL' },
        },
      });
    });

    it('accepts databases without session config', () => {
      expectValid(RawServerConfigSchema, {
        databases: {
          primary: { url_from_env: 'DATABASE_URL' },
        },
      });
    });

    it('accepts top-level redis config with url', () => {
      expectValid(RawServerConfigSchema, {
        redis: { url: 'redis://localhost:6379' },
      });
    });

    it('accepts top-level redis config with host/port/password', () => {
      expectValid(RawServerConfigSchema, {
        redis: { host: 'redis.internal', port: 6380, password: 'secret' },
      });
    });

    it('accepts empty redis config (all fields optional)', () => {
      expectValid(RawServerConfigSchema, {
        redis: {},
      });
    });
  });
});

// =============================================================================
// INTERNAL CONFIG SCHEMAS
// =============================================================================

describe('Internal Config Schemas (config/schemas-internal.ts)', () => {
  // ─── RelationshipTypeSchema ────────────────────────────────────────────────

  describe('RelationshipTypeSchema', () => {
    it('accepts "object"', () => {
      expect(RelationshipTypeSchema.parse('object')).toBe('object');
    });

    it('accepts "array"', () => {
      expect(RelationshipTypeSchema.parse('array')).toBe('array');
    });

    it('rejects invalid type', () => {
      expectInvalid(RelationshipTypeSchema, 'many-to-many');
    });
  });

  // ─── RelationshipConfigSchema ──────────────────────────────────────────────

  describe('RelationshipConfigSchema', () => {
    const validRel = {
      name: 'author',
      type: 'object' as const,
      remoteTable: { name: 'users', schema: 'public' },
    };

    it('accepts a valid relationship config', () => {
      const result = expectValid(RelationshipConfigSchema, validRel);
      expect(result.name).toBe('author');
    });

    it('accepts with optional column fields', () => {
      expectValid(RelationshipConfigSchema, {
        ...validRel,
        localColumns: ['author_id'],
        remoteColumns: ['id'],
        columnMapping: { author_id: 'id' },
      });
    });

    it('rejects missing remoteTable', () => {
      const err = expectInvalid(RelationshipConfigSchema, {
        name: 'x',
        type: 'object',
      });
      expect(err.issues.some((i) => i.path.includes('remoteTable'))).toBe(true);
    });

    it('rejects invalid type enum', () => {
      const err = expectInvalid(RelationshipConfigSchema, {
        ...validRel,
        type: 'belongsTo',
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('strips extra fields (default Zod strip behavior)', () => {
      const result = expectValid(RelationshipConfigSchema, {
        ...validRel,
        unknownField: true,
      });
      // Extra keys are silently removed (Zod default is strip, not strict)
      expect((result as Record<string, unknown>).unknownField).toBeUndefined();
    });
  });

  // ─── Internal Permission Schemas ───────────────────────────────────────────

  describe('SelectPermissionSchema', () => {
    it('accepts valid select permission', () => {
      expectValid(SelectPermissionSchema, {
        columns: ['id', 'name'],
        filter: { id: { _eq: 'X-Hasura-User-Id' } },
      });
    });

    it('accepts wildcard columns', () => {
      expectValid(SelectPermissionSchema, { columns: '*', filter: {} });
    });

    it('rejects number in columns array', () => {
      const err = expectInvalid(SelectPermissionSchema, {
        columns: [123],
        filter: {},
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  describe('InsertPermissionSchema', () => {
    it('accepts valid insert permission', () => {
      expectValid(InsertPermissionSchema, {
        columns: '*',
        check: {},
      });
    });

    it('rejects missing check', () => {
      const err = expectInvalid(InsertPermissionSchema, { columns: '*' });
      expect(err.issues.some((i) => i.path.includes('check'))).toBe(true);
    });
  });

  describe('UpdatePermissionSchema', () => {
    it('accepts valid update permission', () => {
      expectValid(UpdatePermissionSchema, {
        columns: ['name'],
        filter: {},
      });
    });

    it('accepts optional check', () => {
      expectValid(UpdatePermissionSchema, {
        columns: '*',
        filter: {},
        check: { status: { _ne: 'locked' } },
      });
    });
  });

  describe('DeletePermissionSchema', () => {
    it('accepts valid delete permission', () => {
      expectValid(DeletePermissionSchema, { filter: {} });
    });

    it('rejects empty object (missing filter)', () => {
      const err = expectInvalid(DeletePermissionSchema, {});
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── TablePermissionsSchema ────────────────────────────────────────────────

  describe('TablePermissionsSchema', () => {
    it('accepts valid permissions object', () => {
      expectValid(TablePermissionsSchema, {
        select: { user: { columns: '*', filter: {} } },
        insert: { user: { columns: '*', check: {} } },
        update: { user: { columns: '*', filter: {} } },
        delete: { admin: { filter: {} } },
      });
    });

    it('accepts empty permission maps', () => {
      expectValid(TablePermissionsSchema, {
        select: {},
        insert: {},
        update: {},
        delete: {},
      });
    });

    it('rejects missing select key', () => {
      const err = expectInvalid(TablePermissionsSchema, {
        insert: {},
        update: {},
        delete: {},
      });
      expect(err.issues.some((i) => i.path.includes('select'))).toBe(true);
    });
  });

  // ─── CustomRootFieldsSchema ────────────────────────────────────────────────

  describe('CustomRootFieldsSchema', () => {
    it('accepts empty object (all fields optional)', () => {
      expectValid(CustomRootFieldsSchema, {});
    });

    it('accepts all custom root fields', () => {
      expectValid(CustomRootFieldsSchema, {
        select: 'allUsers',
        select_by_pk: 'userByPk',
        select_aggregate: 'usersAggregate',
        insert: 'createUsers',
        insert_one: 'createUser',
        update: 'updateUsers',
        update_by_pk: 'updateUserByPk',
        delete: 'deleteUsers',
        delete_by_pk: 'deleteUserByPk',
      });
    });

    it('rejects non-string value', () => {
      const err = expectInvalid(CustomRootFieldsSchema, { select: 123 });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── WebhookHeaderSchema ───────────────────────────────────────────────────

  describe('WebhookHeaderSchema', () => {
    it('accepts header with name and value', () => {
      expectValid(WebhookHeaderSchema, { name: 'X-Key', value: 'abc' });
    });

    it('accepts header with name and valueFromEnv', () => {
      expectValid(WebhookHeaderSchema, { name: 'X-Key', valueFromEnv: 'API_KEY' });
    });

    it('rejects missing name', () => {
      const err = expectInvalid(WebhookHeaderSchema, { value: 'test' });
      expect(err.issues.some((i) => i.path.includes('name'))).toBe(true);
    });
  });

  // ─── EventTriggerConfigSchema ──────────────────────────────────────────────

  describe('EventTriggerConfigSchema', () => {
    const validTrigger = {
      name: 'on_user_insert',
      definition: {
        insert: { columns: '*' },
      },
      retryConf: {
        intervalSec: 10,
        numRetries: 3,
        timeoutSec: 60,
      },
      webhook: 'https://example.com/hook',
    };

    it('accepts valid event trigger config', () => {
      expectValid(EventTriggerConfigSchema, validTrigger);
    });

    it('rejects missing retryConf.numRetries', () => {
      const trigger = {
        ...validTrigger,
        retryConf: { intervalSec: 10, timeoutSec: 60 },
      };
      const err = expectInvalid(EventTriggerConfigSchema, trigger);
      expect(err.issues.some((i) => i.path.includes('numRetries'))).toBe(true);
    });

    it('rejects missing webhook', () => {
      const { webhook, ...rest } = validTrigger;
      const err = expectInvalid(EventTriggerConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('webhook'))).toBe(true);
    });
  });

  // ─── CronTriggerConfigSchema ───────────────────────────────────────────────

  describe('CronTriggerConfigSchema', () => {
    const validCron = {
      name: 'daily_cleanup',
      webhook: 'https://example.com/cleanup',
      schedule: '0 0 * * *',
    };

    it('accepts valid cron trigger config', () => {
      expectValid(CronTriggerConfigSchema, validCron);
    });

    it('accepts optional fields', () => {
      expectValid(CronTriggerConfigSchema, {
        ...validCron,
        payload: { type: 'cleanup' },
        retryConf: {
          numRetries: 3,
          retryIntervalSeconds: 10,
          timeoutSeconds: 30,
        },
        headers: [{ name: 'X-Key', value: 'val' }],
        comment: 'Nightly cleanup job',
      });
    });

    it('rejects missing schedule', () => {
      const { schedule, ...rest } = validCron;
      const err = expectInvalid(CronTriggerConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('schedule'))).toBe(true);
    });

    it('rejects missing webhook', () => {
      const { webhook, ...rest } = validCron;
      const err = expectInvalid(CronTriggerConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('webhook'))).toBe(true);
    });
  });

  // ─── RequestTransformSchema / ResponseTransformSchema ──────────────────────

  describe('RequestTransformSchema', () => {
    it('accepts empty object (all fields optional)', () => {
      expectValid(RequestTransformSchema, {});
    });

    it('accepts full transform', () => {
      expectValid(RequestTransformSchema, {
        method: 'POST',
        url: '/api/create',
        body: '{{ $body }}',
        contentType: 'application/json',
        queryParams: { version: '2' },
        headers: { 'X-Custom': 'val' },
      });
    });

    it('accepts body as object', () => {
      expectValid(RequestTransformSchema, {
        body: { data: '{{ $body.input }}' },
      });
    });
  });

  describe('ResponseTransformSchema', () => {
    it('accepts empty object', () => {
      expectValid(ResponseTransformSchema, {});
    });

    it('accepts string body', () => {
      expectValid(ResponseTransformSchema, { body: '{{ $body.result }}' });
    });

    it('accepts object body', () => {
      expectValid(ResponseTransformSchema, { body: { result: '{{ $body.data }}' } });
    });
  });

  // ─── ActionRelationshipSchema ──────────────────────────────────────────────

  describe('ActionRelationshipSchema', () => {
    it('accepts a valid action relationship', () => {
      expectValid(ActionRelationshipSchema, {
        name: 'user',
        type: 'object',
        remoteTable: { schema: 'public', name: 'users' },
        fieldMapping: { user_id: 'id' },
      });
    });

    it('rejects missing fieldMapping', () => {
      const err = expectInvalid(ActionRelationshipSchema, {
        name: 'user',
        type: 'object',
        remoteTable: { schema: 'public', name: 'users' },
      });
      expect(err.issues.some((i) => i.path.includes('fieldMapping'))).toBe(true);
    });
  });

  // ─── ActionConfigSchema ────────────────────────────────────────────────────

  describe('ActionConfigSchema', () => {
    const validAction = {
      name: 'createUser',
      definition: {
        kind: 'synchronous' as const,
        type: 'mutation' as const,
        handler: 'https://actions.example.com/create',
      },
    };

    it('accepts a valid action config', () => {
      expectValid(ActionConfigSchema, validAction);
    });

    it('accepts asynchronous kind', () => {
      expectValid(ActionConfigSchema, {
        ...validAction,
        definition: { ...validAction.definition, kind: 'asynchronous' },
      });
    });

    it('accepts query type', () => {
      expectValid(ActionConfigSchema, {
        ...validAction,
        definition: { ...validAction.definition, type: 'query' },
      });
    });

    it('accepts all optional fields', () => {
      expectValid(ActionConfigSchema, {
        ...validAction,
        definition: {
          ...validAction.definition,
          forwardClientHeaders: true,
          headers: [{ name: 'X-Key', value: 'val' }],
          timeout: 30,
        },
        requestTransform: { method: 'POST' },
        responseTransform: { body: '{{ $body }}' },
        permissions: [{ role: 'user' }],
        relationships: [
          {
            name: 'user',
            type: 'object' as const,
            remoteTable: { schema: 'public', name: 'users' },
            fieldMapping: { user_id: 'id' },
          },
        ],
        comment: 'Creates a user',
      });
    });

    it('rejects missing handler', () => {
      const err = expectInvalid(ActionConfigSchema, {
        name: 'x',
        definition: { kind: 'synchronous', type: 'mutation' },
      });
      expect(err.issues.some((i) => i.path.includes('handler'))).toBe(true);
    });

    it('rejects invalid kind', () => {
      const err = expectInvalid(ActionConfigSchema, {
        ...validAction,
        definition: { ...validAction.definition, kind: 'deferred' },
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── RESTEndpointOverrideSchema / RESTConfigSchema ─────────────────────────

  describe('RESTEndpointOverrideSchema', () => {
    it('accepts valid override', () => {
      expectValid(RESTEndpointOverrideSchema, {
        method: 'GET',
        path: '/users',
        operation: 'select',
      });
    });

    it('rejects unknown HTTP method', () => {
      expectInvalid(RESTEndpointOverrideSchema, {
        method: 'HEAD',
        path: '/x',
        operation: 'select',
      });
    });
  });

  describe('RESTConfigSchema', () => {
    const validRest = {
      autoGenerate: true,
      basePath: '/api/v1',
      pagination: { defaultLimit: 20, maxLimit: 100 },
    };

    it('accepts a valid REST config', () => {
      expectValid(RESTConfigSchema, validRest);
    });

    it('accepts with overrides', () => {
      expectValid(RESTConfigSchema, {
        ...validRest,
        overrides: {
          users: [{ method: 'GET', path: '/users', operation: 'select' }],
        },
      });
    });

    it('rejects missing autoGenerate', () => {
      const { autoGenerate, ...rest } = validRest;
      const err = expectInvalid(RESTConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('autoGenerate'))).toBe(true);
    });

    it('rejects missing basePath', () => {
      const { basePath, ...rest } = validRest;
      const err = expectInvalid(RESTConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('basePath'))).toBe(true);
    });

    it('rejects missing pagination', () => {
      const { pagination, ...rest } = validRest;
      const err = expectInvalid(RESTConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('pagination'))).toBe(true);
    });
  });

  // ─── CustomQueryConfigSchema ───────────────────────────────────────────────

  describe('CustomQueryConfigSchema', () => {
    it('accepts valid custom query config', () => {
      expectValid(CustomQueryConfigSchema, {
        name: 'stats',
        type: 'query',
        sql: 'SELECT count(*) FROM users',
        returns: 'StatsResult',
      });
    });

    it('accepts mutation type', () => {
      expectValid(CustomQueryConfigSchema, {
        name: 'reset',
        type: 'mutation',
        sql: 'DELETE FROM logs',
        returns: 'AffectedRows',
      });
    });

    it('accepts params and permissions', () => {
      expectValid(CustomQueryConfigSchema, {
        name: 'q',
        type: 'query',
        sql: 'SELECT 1',
        returns: 'R',
        params: [{ name: 'id', type: 'uuid' }],
        permissions: [{ role: 'admin' }],
      });
    });

    it('rejects invalid type', () => {
      expectInvalid(CustomQueryConfigSchema, {
        name: 'q',
        type: 'subscription',
        sql: 'SELECT 1',
        returns: 'R',
      });
    });
  });

  // ─── APIDocsConfigSchema ───────────────────────────────────────────────────

  describe('APIDocsConfigSchema', () => {
    it('accepts valid docs config', () => {
      expectValid(APIDocsConfigSchema, { generate: true });
    });

    it('accepts all optional fields', () => {
      expectValid(APIDocsConfigSchema, {
        generate: false,
        output: './docs',
        llmFormat: true,
        includeExamples: true,
      });
    });

    it('rejects missing generate', () => {
      const err = expectInvalid(APIDocsConfigSchema, {});
      expect(err.issues.some((i) => i.path.includes('generate'))).toBe(true);
    });

    it('rejects non-boolean generate', () => {
      const err = expectInvalid(APIDocsConfigSchema, { generate: 'yes' });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  // ─── JobQueueConfigSchema ──────────────────────────────────────────────────

  describe('JobQueueConfigSchema', () => {
    it('accepts pg-boss provider', () => {
      expectValid(JobQueueConfigSchema, { provider: 'pg-boss' });
    });

    it('accepts bullmq provider with redis', () => {
      expectValid(JobQueueConfigSchema, {
        provider: 'bullmq',
        redis: { host: 'localhost', port: 6379 },
      });
    });

    it('rejects invalid provider', () => {
      expectInvalid(JobQueueConfigSchema, { provider: 'sidekiq' });
    });

    it('rejects missing provider', () => {
      const err = expectInvalid(JobQueueConfigSchema, {});
      expect(err.issues.some((i) => i.path.includes('provider'))).toBe(true);
    });
  });

  describe('JobQueueProviderSchema', () => {
    it('accepts pg-boss', () => {
      expect(JobQueueProviderSchema.parse('pg-boss')).toBe('pg-boss');
    });

    it('accepts bullmq', () => {
      expect(JobQueueProviderSchema.parse('bullmq')).toBe('bullmq');
    });

    it('rejects unknown provider', () => {
      expectInvalid(JobQueueProviderSchema, 'rabbitmq');
    });
  });

  // ─── AuthConfigSchema ──────────────────────────────────────────────────────

  describe('AuthConfigSchema', () => {
    it('accepts empty object (all fields optional)', () => {
      expectValid(AuthConfigSchema, {});
    });

    it('accepts JWT config', () => {
      expectValid(AuthConfigSchema, {
        jwt: {
          type: 'HS256',
          key: 'my-secret-key',
          claimsNamespace: 'https://hasura.io/jwt/claims',
        },
      });
    });

    it('accepts JWT with claims_map', () => {
      expectValid(AuthConfigSchema, {
        jwt: {
          type: 'RS256',
          jwkUrl: 'https://auth.example.com/.well-known/jwks.json',
          claimsMap: {
            'x-hasura-user-id': { path: '$.sub' },
            'x-hasura-default-role': { path: '$.role', default: 'user' },
          },
        },
      });
    });

    it('accepts webhook config', () => {
      expectValid(AuthConfigSchema, {
        webhook: {
          url: 'https://auth.example.com/verify',
          mode: 'GET',
        },
      });
    });

    it('rejects invalid webhook mode', () => {
      const err = expectInvalid(AuthConfigSchema, {
        webhook: {
          url: 'https://auth.example.com/verify',
          mode: 'PATCH',
        },
      });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('accepts adminSecretEnv and unauthorizedRole', () => {
      expectValid(AuthConfigSchema, {
        adminSecretEnv: 'ADMIN_SECRET',
        unauthorizedRole: 'anonymous',
      });
    });
  });

  // ─── PoolConfigSchema / DatabasesConfigSchema ──────────────────────────────

  describe('PoolConfigSchema', () => {
    it('accepts empty object (all optional)', () => {
      expectValid(PoolConfigSchema, {});
    });

    it('accepts all pool options', () => {
      expectValid(PoolConfigSchema, {
        max: 20,
        idleTimeout: 30000,
        connectionTimeout: 5000,
      });
    });

    it('rejects non-number max', () => {
      expectInvalid(PoolConfigSchema, { max: 'ten' });
    });
  });

  describe('DatabasesConfigSchema', () => {
    const validDbs = {
      primary: { urlEnv: 'DATABASE_URL' },
    };

    it('accepts minimal databases config', () => {
      expectValid(DatabasesConfigSchema, validDbs);
    });

    it('accepts full databases config', () => {
      expectValid(DatabasesConfigSchema, {
        primary: {
          urlEnv: 'DATABASE_URL',
          pool: { max: 10, idleTimeout: 30000 },
        },
        replicas: [
          { urlEnv: 'REPLICA_URL', pool: { max: 5 } },
        ],
        readYourWrites: { enabled: true, windowSeconds: 5 },
        preparedStatements: { enabled: true, maxCached: 200 },
      });
    });

    it('accepts databases config with session connection', () => {
      expectValid(DatabasesConfigSchema, {
        primary: { urlEnv: 'DATABASE_URL' },
        session: { urlEnv: 'DATABASE_SESSION_URL' },
      });
    });

    it('accepts full databases config with session', () => {
      expectValid(DatabasesConfigSchema, {
        primary: {
          urlEnv: 'DATABASE_URL',
          pool: { max: 10 },
        },
        replicas: [{ urlEnv: 'REPLICA_URL' }],
        session: { urlEnv: 'DATABASE_SESSION_URL' },
        readYourWrites: { enabled: true, windowSeconds: 5 },
        preparedStatements: { enabled: true, maxCached: 200 },
      });
    });

    it('rejects session without urlEnv', () => {
      const err = expectInvalid(DatabasesConfigSchema, {
        primary: { urlEnv: 'DATABASE_URL' },
        session: {},
      });
      expect(err.issues.some((i) => i.path.includes('urlEnv'))).toBe(true);
    });

    it('rejects missing primary', () => {
      const err = expectInvalid(DatabasesConfigSchema, {});
      expect(err.issues.some((i) => i.path.includes('primary'))).toBe(true);
    });

    it('rejects primary without urlEnv', () => {
      const err = expectInvalid(DatabasesConfigSchema, { primary: {} });
      expect(err.issues.some((i) => i.path.includes('urlEnv'))).toBe(true);
    });

    it('accepts subscriptionQueryRouting: primary', () => {
      expectValid(DatabasesConfigSchema, {
        primary: { urlEnv: 'DATABASE_URL' },
        subscriptionQueryRouting: 'primary',
      });
    });

    it('accepts subscriptionQueryRouting: replica', () => {
      expectValid(DatabasesConfigSchema, {
        primary: { urlEnv: 'DATABASE_URL' },
        subscriptionQueryRouting: 'replica',
      });
    });

    it('rejects invalid subscriptionQueryRouting value', () => {
      expectInvalid(DatabasesConfigSchema, {
        primary: { urlEnv: 'DATABASE_URL' },
        subscriptionQueryRouting: 'invalid',
      });
    });
  });

  // ─── ComputedFieldConfigSchema ─────────────────────────────────────────────

  describe('ComputedFieldConfigSchema', () => {
    it('accepts valid computed field', () => {
      expectValid(ComputedFieldConfigSchema, {
        name: 'full_name',
        function: { name: 'compute_full_name', schema: 'public' },
      });
    });

    it('accepts optional tableArgument and sessionArgument', () => {
      expectValid(ComputedFieldConfigSchema, {
        name: 'cf',
        function: { name: 'fn' },
        tableArgument: 'row',
        sessionArgument: 'session',
        comment: 'A computed field',
      });
    });

    it('rejects missing function', () => {
      const err = expectInvalid(ComputedFieldConfigSchema, { name: 'cf' });
      expect(err.issues.some((i) => i.path.includes('function'))).toBe(true);
    });
  });

  // ─── RedisConfigSchema ─────────────────────────────────────────────────────

  describe('RedisConfigSchema', () => {
    it('accepts empty object (all optional)', () => {
      expectValid(RedisConfigSchema, {});
    });

    it('accepts url only', () => {
      expectValid(RedisConfigSchema, { url: 'redis://localhost:6379' });
    });

    it('accepts host/port/password', () => {
      expectValid(RedisConfigSchema, { host: 'redis.internal', port: 6380, password: 'secret' });
    });

    it('rejects non-string url', () => {
      expectInvalid(RedisConfigSchema, { url: 123 });
    });

    it('rejects non-number port', () => {
      expectInvalid(RedisConfigSchema, { port: 'abc' });
    });
  });

  // ─── HakkyraConfigSchema ───────────────────────────────────────────────────

  describe('HakkyraConfigSchema', () => {
    const minimalConfig = {
      version: 3,
      server: { port: 8080, host: '0.0.0.0' },
      auth: {},
      databases: { primary: { urlEnv: 'DATABASE_URL' } },
      tables: [],
      actions: [],
      cronTriggers: [],
      rest: {
        autoGenerate: true,
        basePath: '/api/v1',
        pagination: { defaultLimit: 20, maxLimit: 100 },
      },
      customQueries: [],
      apiDocs: { generate: false },
      tableAliases: {},
      eventLogRetentionDays: 30,
      slowQueryThresholdMs: 500,
    };

    it('accepts a minimal valid HakkyraConfig', () => {
      const result = expectValid(HakkyraConfigSchema, minimalConfig);
      expect(result.version).toBe(3);
    });

    it('accepts with optional redis', () => {
      expectValid(HakkyraConfigSchema, {
        ...minimalConfig,
        redis: { url: 'redis://localhost:6379' },
      });
    });

    it('accepts with optional jobQueue', () => {
      expectValid(HakkyraConfigSchema, {
        ...minimalConfig,
        jobQueue: { provider: 'pg-boss' },
      });
    });

    it('rejects missing version', () => {
      const { version, ...rest } = minimalConfig;
      const err = expectInvalid(HakkyraConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('version'))).toBe(true);
    });

    it('rejects missing server', () => {
      const { server, ...rest } = minimalConfig;
      const err = expectInvalid(HakkyraConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('server'))).toBe(true);
    });

    it('rejects missing databases', () => {
      const { databases, ...rest } = minimalConfig;
      const err = expectInvalid(HakkyraConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('databases'))).toBe(true);
    });

    it('rejects missing rest', () => {
      const { rest: _rest, ...remaining } = minimalConfig;
      const err = expectInvalid(HakkyraConfigSchema, remaining);
      expect(err.issues.some((i) => i.path.includes('rest'))).toBe(true);
    });

    it('rejects missing eventLogRetentionDays', () => {
      const { eventLogRetentionDays, ...rest } = minimalConfig;
      const err = expectInvalid(HakkyraConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('eventLogRetentionDays'))).toBe(true);
    });

    it('rejects missing slowQueryThresholdMs', () => {
      const { slowQueryThresholdMs, ...rest } = minimalConfig;
      const err = expectInvalid(HakkyraConfigSchema, rest);
      expect(err.issues.some((i) => i.path.includes('slowQueryThresholdMs'))).toBe(true);
    });

    it('rejects non-number version', () => {
      const err = expectInvalid(HakkyraConfigSchema, { ...minimalConfig, version: '3' });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects empty object', () => {
      const err = expectInvalid(HakkyraConfigSchema, {});
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// REST INPUT VALIDATION SCHEMAS
// =============================================================================

describe('REST Input Validation Schemas (rest/schemas.ts)', () => {
  // ─── MutationBodySchema ────────────────────────────────────────────────────

  describe('MutationBodySchema', () => {
    it('accepts a valid JSON object', () => {
      const result = expectValid(MutationBodySchema, { name: 'Alice', age: 30 });
      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    it('accepts an empty object', () => {
      expectValid(MutationBodySchema, {});
    });

    it('accepts nested objects', () => {
      expectValid(MutationBodySchema, {
        user: { name: 'Bob' },
        tags: ['admin'],
      });
    });

    it('rejects a string', () => {
      expectInvalid(MutationBodySchema, 'not an object');
    });

    it('rejects a number', () => {
      expectInvalid(MutationBodySchema, 42);
    });

    it('rejects null', () => {
      expectInvalid(MutationBodySchema, null);
    });

    it('rejects an array', () => {
      expectInvalid(MutationBodySchema, [{ name: 'Alice' }]);
    });

    it('rejects boolean', () => {
      expectInvalid(MutationBodySchema, true);
    });
  });

  // ─── PaginationSchema ──────────────────────────────────────────────────────

  describe('PaginationSchema', () => {
    it('accepts valid limit and offset', () => {
      const result = expectValid(PaginationSchema, { limit: 10, offset: 20 });
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(20);
    });

    it('accepts empty object (both optional)', () => {
      const result = expectValid(PaginationSchema, {});
      expect(result.limit).toBeUndefined();
      expect(result.offset).toBeUndefined();
    });

    it('accepts only limit', () => {
      const result = expectValid(PaginationSchema, { limit: 5 });
      expect(result.limit).toBe(5);
      expect(result.offset).toBeUndefined();
    });

    it('accepts only offset', () => {
      const result = expectValid(PaginationSchema, { offset: 100 });
      expect(result.offset).toBe(100);
    });

    it('accepts zero values', () => {
      const result = expectValid(PaginationSchema, { limit: 0, offset: 0 });
      expect(result.limit).toBe(0);
      expect(result.offset).toBe(0);
    });

    it('coerces string numbers', () => {
      const result = expectValid(PaginationSchema, { limit: '25', offset: '50' });
      expect(result.limit).toBe(25);
      expect(result.offset).toBe(50);
    });

    it('rejects negative limit', () => {
      const err = expectInvalid(PaginationSchema, { limit: -1 });
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues[0].message).toContain('0');
    });

    it('rejects negative offset', () => {
      const err = expectInvalid(PaginationSchema, { offset: -5 });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects non-integer limit', () => {
      const err = expectInvalid(PaginationSchema, { limit: 10.5 });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects non-integer offset', () => {
      const err = expectInvalid(PaginationSchema, { offset: 3.14 });
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('rejects non-numeric string for limit', () => {
      const err = expectInvalid(PaginationSchema, { limit: 'abc' });
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// EDGE CASES (cross-cutting)
// =============================================================================

describe('Edge cases', () => {
  it('raw schemas accept extra keys (passthrough)', () => {
    // Raw schemas use .passthrough() to allow unknown fields from Hasura YAML
    const result = expectValid(RawVersionYamlSchema, {
      version: 3,
      unknown_field: 'allowed',
      another: 42,
    });
    expect((result as Record<string, unknown>).unknown_field).toBe('allowed');
  });

  it('internal schemas strip extra keys (Zod default strip behavior)', () => {
    // Internal schemas do NOT use .passthrough() — extra keys are silently stripped
    const result = expectValid(RelationshipConfigSchema, {
      name: 'rel',
      type: 'object',
      remoteTable: { name: 'tbl', schema: 'public' },
      extraField: true,
    });
    expect((result as Record<string, unknown>).extraField).toBeUndefined();
  });

  it('handles deeply nested BoolExp in permissions', () => {
    expectValid(RawSelectPermissionSchema, {
      columns: '*',
      filter: {
        _and: [
          { _or: [{ status: { _eq: 'active' } }, { role: { _eq: 'admin' } }] },
          { _not: { archived: { _eq: true } } },
        ],
      },
    });
  });

  it('raw table YAML with empty arrays', () => {
    expectValid(RawTableYamlSchema, {
      table: { schema: 'public', name: 'empty' },
      object_relationships: [],
      array_relationships: [],
      computed_fields: [],
      select_permissions: [],
      insert_permissions: [],
      update_permissions: [],
      delete_permissions: [],
      event_triggers: [],
    });
  });

  it('columns union accepts string array or wildcard, nothing else', () => {
    // Valid: array of strings
    expectValid(RawSelectPermissionSchema, { columns: ['a', 'b'], filter: {} });
    // Valid: wildcard
    expectValid(RawSelectPermissionSchema, { columns: '*', filter: {} });
    // Invalid: single non-wildcard string
    expectInvalid(RawSelectPermissionSchema, { columns: 'name', filter: {} });
    // Invalid: number
    expectInvalid(RawSelectPermissionSchema, { columns: 42, filter: {} });
  });

  it('Zod errors include human-readable messages', () => {
    const err = expectInvalid(HakkyraConfigSchema, {});
    // Should have multiple issues for all the missing required fields
    expect(err.issues.length).toBeGreaterThanOrEqual(5);
    // Each issue should have a non-empty message
    for (const issue of err.issues) {
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('Zod errors contain the correct path for nested fields', () => {
    const err = expectInvalid(HakkyraConfigSchema, {
      version: 3,
      server: { port: 'not-a-number', host: '0.0.0.0' },
      auth: {},
      databases: { primary: { urlEnv: 'DB' } },
      tables: [],
      actions: [],
      cronTriggers: [],
      rest: { autoGenerate: true, basePath: '/', pagination: { defaultLimit: 20, maxLimit: 100 } },
      customQueries: [],
      apiDocs: { generate: false },
      tableAliases: {},
      eventLogRetentionDays: 30,
      slowQueryThresholdMs: 500,
    });
    const portIssue = err.issues.find(
      (i) => i.path.includes('server') && i.path.includes('port'),
    );
    expect(portIssue).toBeDefined();
    expect(portIssue!.message).toContain('number');
  });
});
