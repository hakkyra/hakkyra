/**
 * Zod schemas for raw YAML types, mirroring the interfaces in types.ts.
 */

import { z } from 'zod';

// ─── Hasura metadata version ────────────────────────────────────────────────

export const RawVersionYamlSchema = z
  .object({
    version: z.number().describe('Metadata format version number'),
  })
  .strict()
  .describe('Metadata version file (version.yaml)');

// ─── Database configuration ─────────────────────────────────────────────────

const DatabaseUrlSchema = z.union([
  z.string().describe('Database connection URL as a literal string'),
  z.object({ from_env: z.string().describe('Environment variable containing the database URL') }),
]).describe('Database connection URL — either a literal string or an env var reference');

const PoolSettingsSchema = z
  .object({
    max_connections: z.number().optional().describe('Maximum number of connections in the pool'),
    idle_timeout: z.number().optional().describe('Seconds before an idle connection is closed'),
    connection_lifetime: z.number().optional().describe('Maximum lifetime of a connection in seconds'),
    retries: z.number().optional().describe('Number of connection retry attempts'),
  })
  .strict()
  .describe('Connection pool settings');

const ReadReplicaPoolSettingsSchema = z
  .object({
    max_connections: z.number().optional().describe('Maximum number of connections in the replica pool'),
    idle_timeout: z.number().optional().describe('Seconds before an idle replica connection is closed'),
    connection_lifetime: z.number().optional().describe('Maximum lifetime of a replica connection in seconds'),
    retries: z.number().optional().describe('Number of replica connection retry attempts'),
  })
  .strict()
  .describe('Read replica connection pool settings');

const ConnectionInfoSchema = z
  .object({
    database_url: DatabaseUrlSchema.optional().describe('Database connection URL'),
    pool_settings: PoolSettingsSchema.optional().describe('Connection pool configuration'),
    isolation_level: z.string().optional().describe('Transaction isolation level (e.g. read-committed, serializable)'),
    use_prepared_statements: z.boolean().optional().describe('Whether to use prepared statements for queries'),
  })
  .strict()
  .describe('Database connection configuration');

const ReadReplicaSchema = z
  .object({
    database_url: DatabaseUrlSchema.optional().describe('Read replica connection URL'),
    pool_settings: ReadReplicaPoolSettingsSchema.optional().describe('Read replica pool settings'),
  })
  .strict()
  .describe('Read replica configuration');

const TableIdentifierSchema = z.object({
  schema: z.string().describe('PostgreSQL schema name (e.g. public)'),
  name: z.string().describe('Table name'),
}).describe('Qualified table identifier (schema + name)');

export const RawTableReferenceSchema = z
  .object({
    table: TableIdentifierSchema.describe('Reference to a tracked table'),
  })
  .strict()
  .describe('Table reference wrapper');

// ─── Logical Models & Native Queries (Hasura v2.28+) ────────────────────────

const RawLogicalModelFieldTypeSchema = z
  .object({
    nullable: z.boolean().optional().describe('Whether the field allows null values'),
    scalar: z.string().describe('Scalar type name (e.g. text, integer, boolean)'),
  })
  .strict()
  .describe('Logical model field type definition');

const RawLogicalModelFieldSchema = z
  .object({
    name: z.string().describe('Field name'),
    type: RawLogicalModelFieldTypeSchema.describe('Field type specification'),
  })
  .strict()
  .describe('Logical model field definition');

const RawLogicalModelPermissionSchema = z
  .object({
    permission: z
      .object({
        columns: z.array(z.string()).describe('Columns accessible to this role'),
        filter: z.record(z.string(), z.unknown()).describe('Boolean expression filter for row-level access'),
      })
      .strict()
      .describe('Permission rules'),
    role: z.string().describe('Role name this permission applies to'),
  })
  .strict()
  .describe('Logical model select permission entry');

export const RawLogicalModelSchema = z
  .object({
    name: z.string().describe('Logical model name'),
    fields: z.array(RawLogicalModelFieldSchema).describe('List of fields in the logical model'),
    select_permissions: z.array(RawLogicalModelPermissionSchema).optional().describe('Select permissions for the logical model'),
  })
  .strict()
  .describe('Logical model definition — a virtual table backed by a return type');

const RawNativeQueryArgumentSchema = z
  .object({
    nullable: z.boolean().optional().describe('Whether the argument allows null values'),
    type: z.string().describe('PostgreSQL type of the argument (e.g. text, integer)'),
    description: z.string().optional().describe('Human-readable description of the argument'),
  })
  .strict()
  .describe('Native query argument definition');

export const RawNativeQuerySchema = z
  .object({
    arguments: z.record(z.string(), RawNativeQueryArgumentSchema).optional().describe('Named arguments accepted by the native query'),
    code: z.string().describe('Raw SQL code for the native query'),
    returns: z.string().describe('Name of the logical model this query returns'),
    root_field_name: z.string().describe('GraphQL root field name for the native query'),
  })
  .strict()
  .describe('Native query definition — raw SQL exposed as a GraphQL field');

export const RawDatabaseEntrySchema = z
  .object({
    name: z.string().describe('Database source name (e.g. default)'),
    kind: z.string().describe('Database kind (e.g. postgres)'),
    configuration: z
      .object({
        connection_info: ConnectionInfoSchema.describe('Primary connection configuration'),
        read_replicas: z.array(ReadReplicaSchema).optional().describe('List of read replica configurations'),
      })
      .strict()
      .describe('Database connection and replica configuration'),
    tables: z.unknown().describe('Table definitions — may be an !include reference, file path, or inline array'),
    functions: z.unknown().optional().describe('Tracked function definitions — may be an !include reference, file path, or inline array'),
    native_queries: z.array(RawNativeQuerySchema).optional().describe('Native query definitions'),
    logical_models: z.array(RawLogicalModelSchema).optional().describe('Logical model definitions'),
  })
  .strict()
  .describe('Database source entry in databases.yaml');

export const RawDatabasesYamlSchema = z
  .object({
    databases: z.array(RawDatabaseEntrySchema).optional().describe('List of database sources'),
  })
  .strict()
  .describe('Top-level databases.yaml schema');

// ─── Table configuration ────────────────────────────────────────────────────

const ColumnsSchema = z.union([z.array(z.string()), z.literal('*')]).describe('Column list — array of column names or "*" for all columns');

const BoolExpSchema = z.record(z.string(), z.unknown()).describe('Boolean expression for row-level filtering');

export const RawComputedFieldSchema = z
  .object({
    name: z.string().describe('Computed field name exposed in GraphQL'),
    definition: z
      .object({
        function: z.object({
          name: z.string().describe('SQL function name'),
          schema: z.string().optional().describe('Schema containing the function (default: public)'),
        }).describe('SQL function backing the computed field'),
        table_argument: z.string().optional().describe('Name of the function argument that receives the table row'),
        session_argument: z.string().optional().describe('Name of the function argument that receives session variables'),
      })
      .strict()
      .describe('Computed field function definition'),
    comment: z.string().optional().describe('Description of the computed field'),
  })
  .strict()
  .describe('Computed field definition');

export const RawRelationshipSchema = z
  .object({
    name: z.string().describe('Relationship name exposed in GraphQL'),
    using: z
      .object({
        foreign_key_constraint_on: z
          .union([
            z.string().describe('Single column name for the foreign key'),
            z.array(z.string()).describe('Composite foreign key column names'),
            z.object({
              column: z.string().optional().describe('Foreign key column on the remote table'),
              columns: z.array(z.string()).optional().describe('Composite foreign key columns on the remote table'),
              table: z.union([TableIdentifierSchema, z.string()]).optional().describe('Remote table for the foreign key'),
            }).strict().describe('Foreign key constraint specification with remote table'),
          ])
          .optional()
          .describe('Foreign key constraint configuration'),
        manual_configuration: z
          .object({
            remote_table: TableIdentifierSchema.describe('Target table for the relationship'),
            column_mapping: z.record(z.string(), z.string()).describe('Mapping of local columns to remote columns'),
            insertion_order: z.enum(['before_parent', 'after_parent']).nullable().optional().describe('Insertion order for nested inserts'),
          })
          .strict()
          .optional()
          .describe('Manual relationship configuration (when no FK constraint exists)'),
      })
      .strict()
      .describe('How the relationship is defined — via FK constraint or manual mapping'),
  })
  .strict()
  .describe('Table relationship definition');

// ─── Permissions ────────────────────────────────────────────────────────────

export const RawSelectPermissionSchema = z
  .object({
    columns: ColumnsSchema.describe('Columns this role can select'),
    filter: BoolExpSchema.describe('Row filter applied to all select queries'),
    limit: z.number().optional().describe('Maximum number of rows returned per query'),
    allow_aggregations: z.boolean().optional().describe('Whether this role can run aggregate queries'),
    computed_fields: z.array(z.string()).optional().describe('Computed fields accessible to this role'),
    query_root_fields: z.array(z.string()).optional().describe('Allowed query root fields (e.g. select, select_by_pk)'),
    subscription_root_fields: z.array(z.string()).optional().describe('Allowed subscription root fields'),
  })
  .strict()
  .describe('Select permission rules');

export const RawInsertPermissionSchema = z
  .object({
    columns: ColumnsSchema.describe('Columns this role can insert'),
    check: BoolExpSchema.describe('Row check applied before insert — must evaluate to true'),
    set: z.record(z.string(), z.string()).optional().describe('Column presets — values automatically set on insert'),
    backend_only: z.boolean().optional().describe('Restrict insert to backend (admin) requests only'),
  })
  .strict()
  .describe('Insert permission rules');

export const RawUpdatePermissionSchema = z
  .object({
    columns: ColumnsSchema.describe('Columns this role can update'),
    filter: BoolExpSchema.describe('Row filter — only matching rows can be updated'),
    check: BoolExpSchema.nullable().optional().describe('Post-update check — updated row must satisfy this condition'),
    set: z.record(z.string(), z.string()).optional().describe('Column presets — values automatically set on update'),
  })
  .strict()
  .describe('Update permission rules');

export const RawDeletePermissionSchema = z
  .object({
    filter: BoolExpSchema.describe('Row filter — only matching rows can be deleted'),
  })
  .strict()
  .describe('Delete permission rules');

function permissionEntrySchema<T extends z.ZodTypeAny>(permSchema: T) {
  return z
    .object({
      role: z.string().describe('Role name this permission applies to'),
      permission: permSchema.describe('Permission rules for this role'),
      comment: z.string().optional().describe('Description of this permission entry'),
      backend_only: z.boolean().optional().describe('Restrict to backend (admin) requests only'),
    })
    .strict();
}

export const RawSelectPermissionEntrySchema = permissionEntrySchema(RawSelectPermissionSchema);
export const RawInsertPermissionEntrySchema = permissionEntrySchema(RawInsertPermissionSchema);
export const RawUpdatePermissionEntrySchema = permissionEntrySchema(RawUpdatePermissionSchema);
export const RawDeletePermissionEntrySchema = permissionEntrySchema(RawDeletePermissionSchema);

// ─── Event triggers ─────────────────────────────────────────────────────────

export const RawHeaderSchema = z
  .object({
    name: z.string().describe('Header name'),
    value: z.string().optional().describe('Header value as a literal string'),
    value_from_env: z.string().optional().describe('Environment variable containing the header value'),
  })
  .strict()
  .describe('Webhook header — value from literal string or environment variable');

const EventTriggerColumnSpecSchema = z.object({
  columns: ColumnsSchema.describe('Columns that trigger the event — array of names or "*" for all'),
}).describe('Event trigger column specification');

export const RawEventTriggerSchema = z
  .object({
    name: z.string().describe('Event trigger name'),
    definition: z
      .object({
        enable_manual: z.boolean().optional().describe('Allow manual invocation of the trigger'),
        insert: EventTriggerColumnSpecSchema.optional().describe('Trigger on INSERT operations'),
        update: EventTriggerColumnSpecSchema.optional().describe('Trigger on UPDATE operations'),
        delete: EventTriggerColumnSpecSchema.optional().describe('Trigger on DELETE operations'),
      })
      .strict()
      .describe('Event trigger operation definitions'),
    retry_conf: z
      .object({
        interval_sec: z.number().optional().describe('Seconds between retry attempts'),
        num_retries: z.number().optional().describe('Maximum number of retry attempts'),
        timeout_sec: z.number().optional().describe('Seconds before a delivery attempt times out'),
      })
      .strict()
      .describe('Retry configuration for failed event deliveries'),
    webhook: z.string().optional().describe('Webhook URL for event delivery'),
    webhook_from_env: z.string().optional().describe('Environment variable containing the webhook URL'),
    headers: z.array(RawHeaderSchema).optional().describe('HTTP headers sent with the webhook request'),
    concurrency: z.number().optional().describe('Maximum concurrent webhook deliveries for this trigger'),
  })
  .strict()
  .describe('Event trigger definition');

// ─── Table YAML (full) ─────────────────────────────────────────────────────

export const RawTableYamlSchema = z
  .object({
    table: TableIdentifierSchema.describe('Table identifier (schema + name)'),
    configuration: z
      .object({
        custom_root_fields: z.record(z.string(), z.string()).optional().describe('Custom GraphQL root field names (e.g. select, insert)'),
        custom_column_names: z.record(z.string(), z.string()).optional().describe('Custom GraphQL names for columns'),
        column_config: z.record(z.string(), z.object({
          custom_name: z.string().optional().describe('Custom GraphQL name for this column'),
          comment: z.string().optional().describe('Column description'),
        }).strict()).optional().describe('Per-column configuration'),
        custom_name: z.string().optional().describe('Custom GraphQL type name for the table'),
        comment: z.string().optional().describe('Table description'),
        operations: z
          .object({
            select: z.boolean().optional().describe('Enable select (list) queries'),
            select_by_pk: z.boolean().optional().describe('Enable select by primary key queries'),
            select_aggregate: z.boolean().optional().describe('Enable aggregate queries'),
            insert: z.boolean().optional().describe('Enable insert mutations'),
            insert_one: z.boolean().optional().describe('Enable insert_one mutations'),
            update: z.boolean().optional().describe('Enable update mutations'),
            update_by_pk: z.boolean().optional().describe('Enable update by primary key mutations'),
            update_many: z.boolean().optional().describe('Enable update_many mutations'),
            delete: z.boolean().optional().describe('Enable delete mutations'),
            delete_by_pk: z.boolean().optional().describe('Enable delete by primary key mutations'),
          })
          .strict()
          .optional()
          .describe('Control which CRUD operations are exposed in the schema'),
      })
      .strict()
      .optional()
      .describe('Table-level configuration — naming, comments, and operation toggles'),
    object_relationships: z.array(RawRelationshipSchema).optional().describe('Object (many-to-one) relationships'),
    array_relationships: z.array(RawRelationshipSchema).optional().describe('Array (one-to-many) relationships'),
    computed_fields: z.array(RawComputedFieldSchema).optional().describe('Computed fields backed by SQL functions'),
    select_permissions: z.array(RawSelectPermissionEntrySchema).optional().describe('Select permission entries per role'),
    insert_permissions: z.array(RawInsertPermissionEntrySchema).optional().describe('Insert permission entries per role'),
    update_permissions: z.array(RawUpdatePermissionEntrySchema).optional().describe('Update permission entries per role'),
    delete_permissions: z.array(RawDeletePermissionEntrySchema).optional().describe('Delete permission entries per role'),
    event_triggers: z.array(RawEventTriggerSchema).optional().describe('Event triggers attached to this table'),
    is_enum: z.boolean().optional().describe('Treat this table as a GraphQL enum type'),
  })
  .strict()
  .describe('Full table YAML configuration');

// ─── Actions ────────────────────────────────────────────────────────────────

const RequestTransformSchema = z
  .object({
    method: z.string().optional().describe('HTTP method override (GET, POST, etc.)'),
    url: z.string().optional().describe('URL template override'),
    body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Request body template — string or object (Kriti template)'),
    content_type: z.string().optional().describe('Content-Type header override'),
    query_params: z.record(z.string(), z.string()).optional().describe('Query parameter templates'),
    headers: z.record(z.string(), z.string()).optional().describe('Header templates'),
    template_engine: z.string().optional().describe('Template engine to use (e.g. Kriti)'),
    version: z.number().optional().describe('Transform version'),
  })
  .strict()
  .describe('Request transform — modify the outgoing webhook request');

const ResponseTransformSchema = z
  .object({
    body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Response body template'),
    template_engine: z.string().optional().describe('Template engine to use (e.g. Kriti)'),
    version: z.number().optional().describe('Transform version'),
  })
  .strict()
  .describe('Response transform — modify the webhook response before returning');

const ActionRelationshipSchema = z
  .object({
    name: z.string().describe('Relationship name'),
    type: z.enum(['object', 'array']).describe('Relationship type — object (single) or array (list)'),
    remote_table: z.union([TableIdentifierSchema, z.string()]).describe('Target table for the relationship'),
    field_mapping: z.record(z.string(), z.string()).describe('Mapping of action output fields to table columns'),
  })
  .strict()
  .describe('Action relationship to a tracked table');

export const RawActionSchema = z
  .object({
    name: z.string().describe('Action name — used as the GraphQL field name'),
    definition: z
      .object({
        kind: z.string().optional().describe('Execution kind: synchronous or asynchronous'),
        handler: z.string().optional().describe('Webhook handler URL'),
        handler_from_env: z.string().optional().describe('Environment variable containing the handler URL'),
        forward_client_headers: z.boolean().optional().describe('Forward client HTTP headers to the handler'),
        headers: z.array(RawHeaderSchema).optional().describe('Additional headers sent to the handler'),
        timeout: z.number().optional().describe('Handler timeout in seconds'),
        type: z.string().optional().describe('Action type: query or mutation'),
        arguments: z.array(z.unknown()).optional().describe('Action input arguments (defined in actions.graphql)'),
        output_type: z.string().optional().describe('GraphQL output type name'),
        request_transform: RequestTransformSchema.optional().describe('Transform applied to the outgoing request'),
        response_transform: ResponseTransformSchema.optional().describe('Transform applied to the handler response'),
      })
      .strict()
      .describe('Action definition — handler, type, and transform configuration'),
    permissions: z.array(z.object({ role: z.string().describe('Role allowed to execute this action') }).strict()).optional().describe('Roles allowed to execute this action'),
    relationships: z.array(ActionRelationshipSchema).optional().describe('Relationships from action output to tracked tables'),
    comment: z.string().optional().describe('Description of the action'),
  })
  .strict()
  .describe('Action definition');

export const RawActionsYamlSchema = z
  .object({
    actions: z.array(RawActionSchema).optional().describe('List of action definitions'),
    custom_types: z.unknown().optional().describe('Custom type definitions (parsed from actions.graphql)'),
  })
  .strict()
  .describe('Top-level actions.yaml schema');

// ─── Cron triggers ──────────────────────────────────────────────────────────

export const RawCronTriggerSchema = z
  .object({
    name: z.string().describe('Cron trigger name'),
    webhook: z.string().optional().describe('Webhook URL to invoke on schedule'),
    webhook_from_env: z.string().optional().describe('Environment variable containing the webhook URL'),
    schedule: z.string().describe('Cron expression (e.g. "0 * * * *" for every hour)'),
    payload: z.unknown().optional().describe('Static JSON payload sent with each invocation'),
    retry_conf: z
      .object({
        num_retries: z.number().optional().describe('Maximum number of retry attempts'),
        retry_interval_seconds: z.number().optional().describe('Seconds between retry attempts'),
        timeout_seconds: z.number().optional().describe('Seconds before a delivery attempt times out'),
        tolerance_seconds: z.number().optional().describe('Seconds of tolerance for missed schedules'),
      })
      .strict()
      .optional()
      .describe('Retry configuration for failed deliveries'),
    headers: z.array(RawHeaderSchema).optional().describe('HTTP headers sent with the webhook request'),
    include_in_metadata: z.boolean().optional().describe('Whether to include this trigger in metadata exports'),
    comment: z.string().optional().describe('Description of the cron trigger'),
  })
  .strict()
  .describe('Cron trigger definition');

// ─── REST Override (used by hakkyra.yaml rest.overrides) ─────────────────────

export const RawRESTOverrideSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method for the REST endpoint'),
    path: z.string().describe('URL path for the REST endpoint'),
    operation: z.string().describe('GraphQL operation name to execute'),
    default_order: z.string().optional().describe('Default ORDER BY clause for the endpoint'),
  })
  .strict()
  .describe('REST endpoint override — custom routing for a table operation');

// ─── Query Collections ──────────────────────────────────────────────────

export const RawQueryCollectionQuerySchema = z
  .object({
    name: z.string().describe('Query name within the collection'),
    query: z.string().describe('GraphQL query string'),
  })
  .strict()
  .describe('Named query in a collection');

export const RawQueryCollectionSchema = z
  .object({
    name: z.string().describe('Collection name'),
    definition: z
      .object({
        queries: z.array(RawQueryCollectionQuerySchema).describe('List of named queries'),
      })
      .strict()
      .describe('Collection definition'),
  })
  .strict()
  .describe('Query collection — a named group of GraphQL queries');

// ─── REST Endpoints (Hasura-style) ──────────────────────────────────────

export const RawHasuraRestEndpointSchema = z
  .object({
    name: z.string().describe('Endpoint name'),
    url: z.string().describe('URL path pattern (may include :param placeholders)'),
    methods: z.array(z.string()).describe('Allowed HTTP methods (GET, POST, etc.)'),
    definition: z
      .object({
        query: z.object({
          collection_name: z.string().describe('Query collection containing the query'),
          query_name: z.string().describe('Name of the query within the collection'),
        }).describe('Query reference'),
      })
      .strict()
      .describe('Endpoint definition referencing a query collection'),
    comment: z.string().optional().describe('Description of the REST endpoint'),
  })
  .strict()
  .describe('Hasura-style REST endpoint — maps a URL to a query collection entry');

// ─── Introspection Control ──────────────────────────────────────────────

export const RawIntrospectionConfigSchema = z
  .object({
    disabled_for_roles: z.array(z.string()).optional().describe('Roles for which GraphQL introspection is disabled'),
  })
  .strict()
  .describe('GraphQL introspection access control');

// ─── Tracked Functions ──────────────────────────────────────────────────

export const RawTrackedFunctionSchema = z
  .object({
    function: z.object({
      name: z.string().describe('SQL function name'),
      schema: z.string().optional().describe('Schema containing the function (default: public)'),
    }).describe('Function identifier'),
    configuration: z
      .object({
        exposed_as: z.enum(['query', 'mutation']).optional().describe('Expose the function as a query or mutation'),
        custom_root_fields: z
          .object({
            function: z.string().optional().describe('Custom name for the function root field'),
            function_aggregate: z.string().optional().describe('Custom name for the function aggregate root field'),
          })
          .strict()
          .optional()
          .describe('Custom GraphQL root field names'),
        session_argument: z.string().optional().describe('Function argument that receives session variables'),
      })
      .strict()
      .optional()
      .describe('Function configuration'),
    permissions: z
      .array(z.object({ role: z.string().describe('Role allowed to call this function') }).strict())
      .optional()
      .describe('Roles allowed to call this function'),
  })
  .strict()
  .describe('Tracked function definition');

// ─── Server config (standalone) ─────────────────────────────────────────────

const DbPoolSchema = z
  .object({
    max: z.number().optional().describe('Maximum number of connections in the pool'),
    idle_timeout: z.number().optional().describe('Seconds before an idle connection is closed'),
    connection_timeout: z.number().optional().describe('Seconds to wait for a new connection'),
    max_lifetime: z.number().optional().describe('Maximum lifetime of a connection in seconds'),
    allow_exit_on_idle: z.boolean().optional().describe('Allow the process to exit when all connections are idle'),
  })
  .strict()
  .describe('Database connection pool settings');

const DbConnectionSchema = z
  .object({
    url_from_env: z.string().optional().describe('Environment variable containing the database URL'),
    pool: DbPoolSchema.optional().describe('Connection pool settings'),
  })
  .strict()
  .describe('Database connection configuration');

export const RawServerConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().optional().describe('HTTP port the server listens on'),
        host: z.string().optional().describe('Host address to bind to (e.g. 0.0.0.0, 127.0.0.1)'),
        slow_query_threshold_ms: z.number().optional().describe('Milliseconds above which a query is logged as slow'),
        log_level: z.string().optional().describe('Log level (trace, debug, info, warn, error)'),
        stringify_numeric_types: z.boolean().optional().describe('Return numeric types as strings to avoid precision loss'),
        body_limit: z.number().optional().describe('Maximum request body size in bytes'),
        schema_name: z.string().optional().describe('PostgreSQL schema used for internal Hakkyra tables'),
      })
      .strict()
      .optional()
      .describe('Server configuration'),
    job_queue: z
      .object({
        provider: z.enum(['pg-boss', 'bullmq']).optional().describe('Job queue provider'),
        connection_string: z.string().optional().describe('Database connection string for pg-boss'),
        redis: z
          .object({
            url: z.string().optional().describe('Redis connection URL'),
            host: z.string().optional().describe('Redis host'),
            port: z.number().optional().describe('Redis port'),
            password: z.string().optional().describe('Redis password'),
          })
          .strict()
          .optional()
          .describe('Redis connection for BullMQ provider'),
      })
      .strict()
      .optional()
      .describe('Job queue configuration for async actions, events, and cron triggers'),
    event_log: z
      .object({
        retention_days: z.number().optional().describe('Days to retain event log entries before cleanup'),
      })
      .strict()
      .optional()
      .describe('Event log retention settings'),
    auth: z
      .object({
        jwt: z
          .object({
            type: z.string().optional().describe('JWT signing algorithm (e.g. HS256, RS256)'),
            key: z.string().optional().describe('JWT signing key (literal value)'),
            key_from_env: z.string().optional().describe('Environment variable containing the JWT signing key'),
            jwk_url: z.string().optional().describe('URL to fetch JWK set for token verification'),
            jwk_url_from_env: z.string().optional().describe('Environment variable containing the JWK URL'),
            claims_namespace: z.string().optional().describe('JWT claims namespace for Hasura claims'),
            claims_map: z
              .record(
                z.string(),
                z
                  .object({
                    path: z.string().describe('JSON path to the claim value in the JWT'),
                    default: z.string().optional().describe('Default value if the claim is missing'),
                  })
                  .strict()
                  .describe('Claim mapping entry'),
              )
              .optional()
              .describe('Map claim names to JSON paths in the JWT payload'),
            audience: z.string().optional().describe('Expected JWT audience claim'),
            issuer: z.string().optional().describe('Expected JWT issuer claim'),
            require_exp: z.boolean().optional().describe('Require an expiration claim in the JWT'),
            admin_role_is_admin: z.boolean().optional().describe('Treat the "admin" role claim as full admin access'),
          })
          .strict()
          .optional()
          .describe('JWT authentication configuration'),
        admin_secret_from_env: z.string().optional().describe('Environment variable containing the admin secret'),
        unauthorized_role: z.string().optional().describe('Role assigned to unauthenticated requests'),
        session_namespace: z.string().optional().describe('Header prefix for session variables (e.g. x-hasura)'),
        webhook: z
          .object({
            url: z.string().optional().describe('Auth webhook URL'),
            url_from_env: z.string().optional().describe('Environment variable containing the auth webhook URL'),
            mode: z.enum(['GET', 'POST']).optional().describe('HTTP method used to call the webhook'),
            forward_headers: z.boolean().optional().describe('Forward client headers to the auth webhook'),
          })
          .strict()
          .optional()
          .describe('Webhook-based authentication configuration'),
      })
      .strict()
      .optional()
      .describe('Authentication and authorization configuration'),
    databases: z
      .object({
        primary: DbConnectionSchema.optional().describe('Primary database connection'),
        replicas: z.array(DbConnectionSchema).optional().describe('Read replica connections'),
        session: z
          .object({
            url_from_env: z.string().optional().describe('Environment variable for session store database URL'),
          })
          .strict()
          .optional()
          .describe('Separate database for session tracking'),
        read_your_writes: z
          .object({
            enabled: z.boolean().optional().describe('Enable read-your-writes consistency'),
            window_seconds: z.number().optional().describe('Seconds after a write during which reads go to primary'),
          })
          .strict()
          .optional()
          .describe('Read-your-writes consistency settings'),
        prepared_statements: z
          .object({
            enabled: z.boolean().optional().describe('Enable prepared statement caching'),
            max_cached: z.number().optional().describe('Maximum number of cached prepared statements'),
          })
          .strict()
          .optional()
          .describe('Prepared statement caching configuration'),
        subscription_query_routing: z.enum(['primary', 'replica']).optional().describe('Route subscription poll queries to primary or replica'),
      })
      .strict()
      .optional()
      .describe('Database connection configuration'),
    redis: z
      .object({
        url: z.string().optional().describe('Redis connection URL'),
        url_from_env: z.string().optional().describe('Environment variable containing the Redis URL'),
        host: z.string().optional().describe('Redis host'),
        port: z.number().optional().describe('Redis port'),
        password: z.string().optional().describe('Redis password'),
      })
      .strict()
      .optional()
      .describe('Redis connection for caching and pub/sub'),
    query_cache: z
      .object({
        max_size: z.number().optional().describe('Maximum number of cached query plans'),
      })
      .strict()
      .optional()
      .describe('Query plan cache settings'),
    subscriptions: z
      .object({
        debounce_ms: z.number().optional().describe('Milliseconds to debounce subscription poll queries'),
        keep_alive_ms: z.number().optional().describe('Milliseconds between WebSocket keep-alive pings'),
      })
      .strict()
      .optional()
      .describe('GraphQL subscription settings'),
    event_delivery: z
      .object({
        batch_size: z.number().optional().describe('Number of events fetched per delivery batch'),
        http_concurrency: z.number().optional().describe('Maximum concurrent webhook delivery requests'),
      })
      .strict()
      .optional()
      .describe('Event delivery tuning'),
    event_cleanup: z
      .object({
        schedule: z.string().optional().describe('Cron expression for event log cleanup (default: "0 3 * * *")'),
      })
      .strict()
      .optional()
      .describe('Automatic event log cleanup schedule'),
    webhook: z
      .object({
        timeout_ms: z.number().optional().describe('Milliseconds before a webhook request times out'),
        backoff_cap_seconds: z.number().optional().describe('Maximum backoff delay in seconds for webhook retries'),
        allow_private_urls: z.boolean().optional().describe('Allow webhooks to private/internal URLs'),
        max_response_bytes: z.number().optional().describe('Maximum webhook response body size in bytes'),
      })
      .strict()
      .optional()
      .describe('Global webhook delivery settings'),
    action_defaults: z
      .object({
        timeout_seconds: z.number().optional().describe('Default timeout for synchronous actions in seconds'),
        async_retry_limit: z.number().optional().describe('Default retry limit for async actions'),
        async_retry_delay_seconds: z.number().optional().describe('Default delay between async action retries in seconds'),
        async_timeout_seconds: z.number().optional().describe('Default timeout for async actions in seconds'),
      })
      .strict()
      .optional()
      .describe('Default settings for actions'),
    graphql: z
      .object({
        query_depth: z.number().optional().describe('Maximum allowed query nesting depth'),
        max_limit: z.number().optional().describe('Maximum rows returned by any query'),
        max_batch_size: z.number().optional().describe('Maximum number of operations in a batched GraphQL request'),
      })
      .strict()
      .optional()
      .describe('GraphQL engine settings'),
    sql: z
      .object({
        array_any_threshold: z.number().optional().describe('Number of values above which IN lists use ANY(ARRAY[...])'),
        unnest_threshold: z.number().optional().describe('Number of values above which IN lists use UNNEST'),
        batch_chunk_size: z.number().optional().describe('Rows per chunk for batch insert/update operations'),
      })
      .strict()
      .optional()
      .describe('SQL generation tuning'),
    schema: z
      .object({
        default_operations: z
          .object({
            select: z.boolean().optional().describe('Enable select (list) queries by default'),
            select_by_pk: z.boolean().optional().describe('Enable select-by-pk queries by default'),
            select_aggregate: z.boolean().optional().describe('Enable aggregate queries by default'),
            insert: z.boolean().optional().describe('Enable insert mutations by default'),
            insert_one: z.boolean().optional().describe('Enable insert_one mutations by default'),
            update: z.boolean().optional().describe('Enable update mutations by default'),
            update_by_pk: z.boolean().optional().describe('Enable update-by-pk mutations by default'),
            update_many: z.boolean().optional().describe('Enable update_many mutations by default'),
            delete: z.boolean().optional().describe('Enable delete mutations by default'),
            delete_by_pk: z.boolean().optional().describe('Enable delete-by-pk mutations by default'),
          })
          .strict()
          .optional()
          .describe('Default CRUD operations exposed for all tables'),
      })
      .strict()
      .optional()
      .describe('Schema generation settings'),
    rest: z
      .object({
        auto_generate: z.boolean().optional().describe('Auto-generate REST endpoints for tracked tables'),
        base_path: z.string().optional().describe('Base URL path for REST endpoints'),
        pagination: z
          .object({
            default_limit: z.number().optional().describe('Default page size for REST list endpoints'),
            max_limit: z.number().optional().describe('Maximum page size for REST list endpoints'),
          })
          .strict()
          .optional()
          .describe('REST pagination defaults'),
        overrides: z.record(z.string(), z.array(RawRESTOverrideSchema)).optional().describe('Per-table REST endpoint overrides, keyed by table name'),
      })
      .strict()
      .optional()
      .describe('REST API configuration'),
    docs: z
      .object({
        generate: z.boolean().optional().describe('Enable API documentation generation'),
        output: z.string().optional().describe('Output directory for generated docs'),
        llm_format: z.boolean().optional().describe('Generate LLM-friendly documentation format'),
        include_examples: z.boolean().optional().describe('Include example queries in generated docs'),
      })
      .strict()
      .optional()
      .describe('API documentation generation settings'),
  })
  .strict()
  .describe('Top-level hakkyra.yaml server configuration');
