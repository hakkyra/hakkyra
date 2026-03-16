import { z } from 'zod';
import type { BoolExp } from '../types.js';

// ---------------------------------------------------------------------------
// BoolExp helper — recursive/dynamic, validated as a generic record.
// Typed as ZodType<BoolExp> so that z.infer produces the manual BoolExp union
// instead of a plain Record<string, unknown>.
// ---------------------------------------------------------------------------

const BoolExpSchema: z.ZodType<BoolExp> = z.record(z.string(), z.unknown()) as z.ZodType<BoolExp>;

// ---------------------------------------------------------------------------
// RelationshipConfig
// ---------------------------------------------------------------------------

export const RelationshipTypeSchema = z.enum(['object', 'array']).describe('Relationship cardinality — object (many-to-one) or array (one-to-many)');

export const InsertionOrderSchema = z.enum(['before_parent', 'after_parent']).describe('Insertion order for nested inserts');

export const RelationshipConfigSchema = z.object({
  name: z.string().describe('Relationship name exposed in GraphQL'),
  type: RelationshipTypeSchema.describe('Relationship type'),
  remoteTable: z.object({
    name: z.string().describe('Remote table name'),
    schema: z.string().describe('Remote table schema'),
  }).describe('Target table for the relationship'),
  localColumns: z.array(z.string()).optional().describe('Local columns used in the join'),
  remoteColumns: z.array(z.string()).optional().describe('Remote columns used in the join'),
  columnMapping: z.record(z.string(), z.string()).optional().describe('Explicit mapping of local columns to remote columns'),
  insertionOrder: InsertionOrderSchema.optional().describe('Insertion order for nested inserts'),
  fromMetadata: z.boolean().optional().describe('Whether this relationship was defined in metadata (vs. inferred from FK)'),
}).describe('Internal relationship configuration');

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const columnsSchema = z.union([z.array(z.string()), z.literal('*')]).describe('Column list — array of names or "*" for all columns');

export const SelectPermissionSchema = z.object({
  columns: columnsSchema.describe('Columns this role can select'),
  filter: BoolExpSchema.describe('Row filter applied to select queries'),
  limit: z.number().optional().describe('Maximum rows returned per query'),
  allowAggregations: z.boolean().optional().describe('Whether this role can run aggregate queries'),
  computedFields: z.array(z.string()).optional().describe('Computed fields accessible to this role'),
  queryRootFields: z.array(z.string()).optional().describe('Allowed query root fields'),
  subscriptionRootFields: z.array(z.string()).optional().describe('Allowed subscription root fields'),
}).describe('Select permission rules');

export const InsertPermissionSchema = z.object({
  columns: columnsSchema.describe('Columns this role can insert'),
  check: BoolExpSchema.describe('Row check — must be true for the insert to succeed'),
  set: z.record(z.string(), z.string()).optional().describe('Column presets automatically set on insert'),
  backendOnly: z.boolean().optional().describe('Restrict to backend (admin) requests only'),
}).describe('Insert permission rules');

export const UpdatePermissionSchema = z.object({
  columns: columnsSchema.describe('Columns this role can update'),
  filter: BoolExpSchema.describe('Row filter — only matching rows can be updated'),
  check: BoolExpSchema.optional().describe('Post-update check on the updated row'),
  set: z.record(z.string(), z.string()).optional().describe('Column presets automatically set on update'),
}).describe('Update permission rules');

export const DeletePermissionSchema = z.object({
  filter: BoolExpSchema.describe('Row filter — only matching rows can be deleted'),
}).describe('Delete permission rules');

export const TablePermissionsSchema = z.object({
  select: z.record(z.string(), SelectPermissionSchema).describe('Select permissions keyed by role'),
  insert: z.record(z.string(), InsertPermissionSchema).describe('Insert permissions keyed by role'),
  update: z.record(z.string(), UpdatePermissionSchema).describe('Update permissions keyed by role'),
  delete: z.record(z.string(), DeletePermissionSchema).describe('Delete permissions keyed by role'),
}).describe('All permissions for a table, grouped by operation');

// ---------------------------------------------------------------------------
// CustomRootFields
// ---------------------------------------------------------------------------

export const CustomRootFieldsSchema = z.object({
  select: z.string().optional().describe('Custom name for the select (list) root field'),
  select_by_pk: z.string().optional().describe('Custom name for the select-by-pk root field'),
  select_aggregate: z.string().optional().describe('Custom name for the aggregate root field'),
  select_stream: z.string().optional().describe('Custom name for the streaming subscription root field'),
  insert: z.string().optional().describe('Custom name for the insert root field'),
  insert_one: z.string().optional().describe('Custom name for the insert_one root field'),
  update: z.string().optional().describe('Custom name for the update root field'),
  update_by_pk: z.string().optional().describe('Custom name for the update-by-pk root field'),
  update_many: z.string().optional().describe('Custom name for the update_many root field'),
  delete: z.string().optional().describe('Custom name for the delete root field'),
  delete_by_pk: z.string().optional().describe('Custom name for the delete-by-pk root field'),
}).describe('Custom GraphQL root field names for a table');

// ---------------------------------------------------------------------------
// WebhookHeader
// ---------------------------------------------------------------------------

export const WebhookHeaderSchema = z.object({
  name: z.string().describe('Header name'),
  value: z.string().optional().describe('Header value as a literal string'),
  valueFromEnv: z.string().optional().describe('Environment variable containing the header value'),
}).describe('Webhook header — value from literal or environment variable');

// ---------------------------------------------------------------------------
// EventTriggerConfig
// ---------------------------------------------------------------------------

const eventTriggerOperationSchema = z.object({
  columns: columnsSchema.describe('Columns that trigger the event'),
}).describe('Event trigger operation — which columns trigger events');

export const EventTriggerConfigSchema = z.object({
  name: z.string().describe('Event trigger name'),
  definition: z.object({
    enableManual: z.boolean().optional().describe('Allow manual invocation of the trigger'),
    insert: eventTriggerOperationSchema.optional().describe('Trigger on INSERT operations'),
    update: eventTriggerOperationSchema.optional().describe('Trigger on UPDATE operations'),
    delete: eventTriggerOperationSchema.optional().describe('Trigger on DELETE operations'),
  }).describe('Event trigger operation definitions'),
  retryConf: z.object({
    intervalSec: z.number().describe('Seconds between retry attempts'),
    numRetries: z.number().describe('Maximum number of retry attempts'),
    timeoutSec: z.number().describe('Seconds before a delivery attempt times out'),
  }).describe('Retry configuration for failed deliveries'),
  webhook: z.string().describe('Webhook URL for event delivery'),
  webhookFromEnv: z.string().optional().describe('Environment variable containing the webhook URL'),
  headers: z.array(WebhookHeaderSchema).optional().describe('HTTP headers sent with the webhook request'),
  concurrency: z.number().optional().describe('Maximum concurrent webhook deliveries'),
}).describe('Event trigger configuration');

// ---------------------------------------------------------------------------
// CronTriggerConfig
// ---------------------------------------------------------------------------

export const CronTriggerConfigSchema = z.object({
  name: z.string().describe('Cron trigger name'),
  webhook: z.string().describe('Webhook URL to invoke on schedule'),
  webhookFromEnv: z.string().optional().describe('Environment variable containing the webhook URL'),
  schedule: z.string().describe('Cron expression (e.g. "0 * * * *")'),
  payload: z.unknown().optional().describe('Static JSON payload sent with each invocation'),
  retryConf: z
    .object({
      numRetries: z.number().describe('Maximum number of retry attempts'),
      retryIntervalSeconds: z.number().describe('Seconds between retry attempts'),
      timeoutSeconds: z.number().describe('Seconds before a delivery attempt times out'),
      toleranceSeconds: z.number().optional().describe('Seconds of tolerance for missed schedules'),
    })
    .optional()
    .describe('Retry configuration for failed deliveries'),
  headers: z.array(WebhookHeaderSchema).optional().describe('HTTP headers sent with the webhook request'),
  comment: z.string().optional().describe('Description of the cron trigger'),
}).describe('Cron trigger configuration');

// ---------------------------------------------------------------------------
// RequestTransform / ResponseTransform
// ---------------------------------------------------------------------------

export const RequestTransformSchema = z.object({
  method: z.string().optional().describe('HTTP method override'),
  url: z.string().optional().describe('URL template override'),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Request body template'),
  contentType: z.string().optional().describe('Content-Type header override'),
  queryParams: z.record(z.string(), z.string()).optional().describe('Query parameter templates'),
  headers: z.record(z.string(), z.string()).optional().describe('Header templates'),
  templateEngine: z.string().optional().describe('Template engine (e.g. Kriti)'),
}).describe('Request transform — modify the outgoing webhook request');

export const ResponseTransformSchema = z.object({
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('Response body template'),
  templateEngine: z.string().optional().describe('Template engine (e.g. Kriti)'),
}).describe('Response transform — modify the webhook response');

// ---------------------------------------------------------------------------
// ActionRelationship
// ---------------------------------------------------------------------------

export const ActionRelationshipSchema = z.object({
  name: z.string().describe('Relationship name'),
  type: z.enum(['object', 'array']).describe('Relationship type — object (single) or array (list)'),
  remoteTable: z.object({
    schema: z.string().describe('Remote table schema'),
    name: z.string().describe('Remote table name'),
  }).describe('Target table for the relationship'),
  fieldMapping: z.record(z.string(), z.string()).describe('Mapping of action output fields to table columns'),
}).describe('Action relationship to a tracked table');

// ---------------------------------------------------------------------------
// ActionConfig
// ---------------------------------------------------------------------------

export const ActionConfigSchema = z.object({
  name: z.string().describe('Action name — used as the GraphQL field name'),
  definition: z.object({
    kind: z.enum(['synchronous', 'asynchronous']).default('synchronous').describe('Execution kind'),
    type: z.enum(['query', 'mutation']).default('mutation').describe('GraphQL operation type'),
    handler: z.string().describe('Webhook handler URL'),
    handlerFromEnv: z.string().optional().describe('Environment variable containing the handler URL'),
    forwardClientHeaders: z.boolean().optional().describe('Forward client HTTP headers to the handler'),
    headers: z.array(WebhookHeaderSchema).optional().describe('Additional headers sent to the handler'),
    timeout: z.number().optional().describe('Handler timeout in seconds'),
  }).describe('Action definition — handler, type, and execution mode'),
  requestTransform: RequestTransformSchema.optional().describe('Transform applied to the outgoing request'),
  responseTransform: ResponseTransformSchema.optional().describe('Transform applied to the handler response'),
  permissions: z.array(z.object({ role: z.string().describe('Role name') })).optional().describe('Roles allowed to execute this action'),
  relationships: z.array(ActionRelationshipSchema).optional().describe('Relationships from action output to tracked tables'),
  comment: z.string().optional().describe('Description of the action'),
}).describe('Action configuration');

// ---------------------------------------------------------------------------
// REST config
// ---------------------------------------------------------------------------

export const RESTEndpointOverrideSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method for the endpoint'),
  path: z.string().describe('URL path for the endpoint'),
  operation: z.string().describe('GraphQL operation name'),
  defaultOrder: z.string().optional().describe('Default ORDER BY clause'),
}).describe('REST endpoint override');

export const RESTConfigSchema = z.object({
  autoGenerate: z.boolean().default(true).describe('Auto-generate REST endpoints for tracked tables'),
  basePath: z.string().default('/api').describe('Base URL path for REST endpoints'),
  pagination: z.object({
    defaultLimit: z.number().default(20).describe('Default page size'),
    maxLimit: z.number().default(100).describe('Maximum page size'),
  }).default({ defaultLimit: 20, maxLimit: 100 }).describe('REST pagination settings'),
  overrides: z.record(z.string(), z.array(RESTEndpointOverrideSchema)).optional().describe('Per-table REST endpoint overrides'),
}).describe('REST API configuration');

// ---------------------------------------------------------------------------
// APIDocsConfig
// ---------------------------------------------------------------------------

export const APIDocsConfigSchema = z.object({
  generate: z.boolean().describe('Enable API documentation generation'),
  output: z.string().optional().describe('Output directory for generated docs'),
  llmFormat: z.boolean().optional().describe('Generate LLM-friendly format'),
}).describe('API documentation settings');

// ---------------------------------------------------------------------------
// JobQueueConfig
// ---------------------------------------------------------------------------

export const JobQueueProviderSchema = z.enum(['pg-boss', 'bullmq']).describe('Job queue provider');

export const JobQueueConfigSchema = z.object({
  provider: JobQueueProviderSchema.default('pg-boss').describe('Job queue provider'),
  connectionString: z.string().optional().describe('Database connection string for pg-boss'),
  redis: z
    .object({
      url: z.string().optional().describe('Redis connection URL'),
      host: z.string().optional().describe('Redis host'),
      port: z.number().optional().describe('Redis port'),
      password: z.string().optional().describe('Redis password'),
    })
    .optional()
    .describe('Redis connection for BullMQ provider'),
  gracefulShutdownMs: z.number().default(10000).describe('Milliseconds to wait for graceful shutdown'),
}).describe('Job queue configuration');

// ---------------------------------------------------------------------------
// AuthConfig
// ---------------------------------------------------------------------------

export const AuthConfigSchema = z.object({
  jwt: z
    .object({
      type: z.string().default('HS256').describe('JWT signing algorithm (e.g. HS256, RS256)'),
      key: z.string().optional().describe('JWT signing key (literal value)'),
      keyEnv: z.string().optional().describe('Environment variable containing the JWT key'),
      jwkUrl: z.string().optional().describe('URL to fetch JWK set'),
      jwkUrlEnv: z.string().optional().describe('Environment variable containing the JWK URL'),
      claimsNamespace: z.string().optional().describe('JWT claims namespace for Hasura claims'),
      claimsMap: z
        .record(
          z.string(),
          z.object({
            path: z.string().describe('JSON path to the claim value'),
            default: z.string().optional().describe('Default value if claim is missing'),
          }),
        )
        .optional()
        .describe('Map claim names to JSON paths in the JWT'),
      audience: z.string().optional().describe('Expected JWT audience claim'),
      issuer: z.string().optional().describe('Expected JWT issuer claim'),
      requireExp: z.boolean().default(true).describe('Require expiration claim in JWT'),
      adminRoleIsAdmin: z.boolean().default(false).describe('Treat "admin" role as full admin access'),
    })
    .optional()
    .describe('JWT authentication configuration'),
  adminSecretEnv: z.string().optional().describe('Environment variable containing the admin secret'),
  unauthorizedRole: z.string().optional().describe('Role assigned to unauthenticated requests'),
  sessionNamespace: z.string().default('x-hk').describe('Header prefix for session variables'),
  webhook: z
    .object({
      url: z.string().describe('Auth webhook URL'),
      urlFromEnv: z.string().optional().describe('Environment variable containing the webhook URL'),
      mode: z.enum(['GET', 'POST']).default('GET').describe('HTTP method for the webhook'),
      forwardHeaders: z.boolean().optional().describe('Forward client headers to the webhook'),
    })
    .optional()
    .describe('Webhook-based authentication'),
}).describe('Authentication and authorization configuration');

// ---------------------------------------------------------------------------
// RedisConfig
// ---------------------------------------------------------------------------

export const RedisConfigSchema = z.object({
  url: z.string().optional().describe('Redis connection URL'),
  urlEnv: z.string().optional().describe('Environment variable containing the Redis URL'),
  host: z.string().optional().describe('Redis host'),
  port: z.number().default(6379).describe('Redis port'),
  password: z.string().optional().describe('Redis password'),
}).describe('Redis connection configuration');

// ---------------------------------------------------------------------------
// DatabasesConfig / PoolConfig
// ---------------------------------------------------------------------------

export const PoolConfigSchema = z.object({
  max: z.number().default(10).describe('Maximum connections in the pool'),
  idleTimeout: z.number().default(30).describe('Seconds before idle connections are closed'),
  connectionTimeout: z.number().default(5).describe('Seconds to wait for a new connection'),
  maxLifetime: z.number().optional().describe('Maximum lifetime of a connection in seconds'),
  allowExitOnIdle: z.boolean().optional().describe('Allow process exit when all connections are idle'),
}).describe('Connection pool settings');

export const DatabasesConfigSchema = z.object({
  primary: z.object({
    urlEnv: z.string().describe('Environment variable containing the primary database URL'),
    pool: PoolConfigSchema.optional().describe('Primary connection pool settings'),
  }).describe('Primary database connection'),
  replicas: z
    .array(
      z.object({
        urlEnv: z.string().describe('Environment variable containing the replica URL'),
        pool: PoolConfigSchema.optional().describe('Replica connection pool settings'),
      }).describe('Read replica connection'),
    )
    .optional()
    .describe('Read replica connections'),
  session: z
    .object({
      urlEnv: z.string().describe('Environment variable for session store database URL'),
    })
    .optional()
    .describe('Separate database for session tracking'),
  readYourWrites: z
    .object({
      enabled: z.boolean().default(false).describe('Enable read-your-writes consistency'),
      windowSeconds: z.number().default(5).describe('Seconds after a write to route reads to primary'),
    })
    .optional()
    .describe('Read-your-writes consistency settings'),
  preparedStatements: z
    .object({
      enabled: z.boolean().describe('Enable prepared statement caching'),
      maxCached: z.number().optional().describe('Maximum number of cached prepared statements'),
    })
    .optional()
    .describe('Prepared statement caching'),
  subscriptionQueryRouting: z.enum(['primary', 'replica']).optional().describe('Route subscription queries to primary or replica'),
}).describe('Database connection configuration');

// ---------------------------------------------------------------------------
// ComputedFieldConfig
// ---------------------------------------------------------------------------

export const ComputedFieldConfigSchema = z.object({
  name: z.string().describe('Computed field name in GraphQL'),
  function: z.object({
    name: z.string().describe('SQL function name'),
    schema: z.string().optional().describe('Schema containing the function'),
  }).describe('SQL function backing the computed field'),
  tableArgument: z.string().optional().describe('Function argument that receives the table row'),
  sessionArgument: z.string().optional().describe('Function argument that receives session variables'),
  comment: z.string().optional().describe('Description of the computed field'),
}).describe('Computed field configuration');

// ---------------------------------------------------------------------------
// TrackedFunctionConfig
// ---------------------------------------------------------------------------

export const TrackedFunctionConfigSchema = z.object({
  name: z.string().describe('SQL function name'),
  schema: z.string().default('public').describe('Schema containing the function'),
  exposedAs: z.enum(['query', 'mutation']).optional().describe('Expose as a query or mutation'),
  customRootFields: z.object({
    function: z.string().optional().describe('Custom name for the function root field'),
    functionAggregate: z.string().optional().describe('Custom name for the function aggregate root field'),
  }).optional().describe('Custom GraphQL root field names'),
  sessionArgument: z.string().optional().describe('Function argument that receives session variables'),
  permissions: z.array(z.object({ role: z.string().describe('Role name') })).optional().describe('Roles allowed to call this function'),
}).describe('Tracked function configuration');

// ---------------------------------------------------------------------------
// LogicalModel & NativeQuery
// ---------------------------------------------------------------------------

export const LogicalModelFieldSchema = z.object({
  name: z.string().describe('Field name'),
  type: z.string().describe('Scalar type name'),
  nullable: z.boolean().describe('Whether the field allows null values'),
}).describe('Logical model field');

export const LogicalModelPermissionSchema = z.object({
  role: z.string().describe('Role name'),
  columns: z.array(z.string()).describe('Columns accessible to this role'),
  filter: BoolExpSchema.describe('Row filter for this role'),
}).describe('Logical model select permission');

export const LogicalModelSchema = z.object({
  name: z.string().describe('Logical model name'),
  fields: z.array(LogicalModelFieldSchema).describe('Fields in the logical model'),
  selectPermissions: z.array(LogicalModelPermissionSchema).default([]).describe('Select permissions'),
}).describe('Logical model definition');

export const NativeQueryArgumentSchema = z.object({
  name: z.string().describe('Argument name'),
  type: z.string().describe('PostgreSQL type'),
  nullable: z.boolean().describe('Whether the argument allows null'),
}).describe('Native query argument');

export const NativeQuerySchema = z.object({
  rootFieldName: z.string().describe('GraphQL root field name'),
  code: z.string().describe('Raw SQL code'),
  arguments: z.array(NativeQueryArgumentSchema).default([]).describe('Query arguments'),
  returns: z.string().describe('Logical model name for the return type'),
}).describe('Native query definition');

// ---------------------------------------------------------------------------
// QueryCollection
// ---------------------------------------------------------------------------

export const QueryCollectionSchema = z.object({
  name: z.string().describe('Collection name'),
  queries: z.map(z.string(), z.string()).describe('Map of query names to GraphQL query strings'),
}).describe('Query collection — named group of GraphQL queries');

// ---------------------------------------------------------------------------
// HasuraRestEndpoint
// ---------------------------------------------------------------------------

export const HasuraRestEndpointSchema = z.object({
  name: z.string().describe('Endpoint name'),
  url: z.string().describe('URL path pattern (may include :param placeholders)'),
  methods: z.array(z.string()).describe('Allowed HTTP methods'),
  collectionName: z.string().describe('Query collection containing the query'),
  queryName: z.string().describe('Query name within the collection'),
  comment: z.string().optional().describe('Description of the endpoint'),
}).describe('Hasura-style REST endpoint');

// ---------------------------------------------------------------------------
// IntrospectionConfig
// ---------------------------------------------------------------------------

export const IntrospectionConfigSchema = z.object({
  disabledForRoles: z.array(z.string()).default([]).describe('Roles for which introspection is disabled'),
}).describe('GraphQL introspection access control');

// ---------------------------------------------------------------------------
// OperationsConfig — controls which CRUD root fields are exposed
// ---------------------------------------------------------------------------

export const OperationsConfigSchema = z.object({
  select: z.boolean().default(true).describe('Enable select (list) queries'),
  selectByPk: z.boolean().default(true).describe('Enable select-by-pk queries'),
  selectAggregate: z.boolean().default(true).describe('Enable aggregate queries'),
  insert: z.boolean().default(true).describe('Enable insert mutations'),
  insertOne: z.boolean().default(true).describe('Enable insert_one mutations'),
  update: z.boolean().default(true).describe('Enable update mutations'),
  updateByPk: z.boolean().default(true).describe('Enable update-by-pk mutations'),
  updateMany: z.boolean().default(true).describe('Enable update_many mutations'),
  delete: z.boolean().default(true).describe('Enable delete mutations'),
  deleteByPk: z.boolean().default(true).describe('Enable delete-by-pk mutations'),
}).describe('Controls which CRUD operations are exposed in the GraphQL schema');

// ---------------------------------------------------------------------------
// HakkyraConfig (top-level)
// ---------------------------------------------------------------------------

export const HakkyraConfigSchema = z.object({
  version: z.number().describe('Configuration format version'),
  server: z.object({
    port: z.number().default(3000).describe('HTTP port the server listens on'),
    host: z.string().default('0.0.0.0').describe('Host address to bind to'),
    logLevel: z.string().default('info').describe('Log level (trace, debug, info, warn, error)'),
    stringifyNumericTypes: z.boolean().default(false).describe('Return numeric types as strings to avoid precision loss'),
    bodyLimit: z.number().default(1048576).describe('Maximum request body size in bytes'),
    schemaName: z.string().default('hakkyra').describe('PostgreSQL schema for internal Hakkyra tables'),
  }).default({ port: 3000, host: '0.0.0.0', logLevel: 'info', stringifyNumericTypes: false, bodyLimit: 1048576, schemaName: 'hakkyra' }).describe('Server settings'),
  auth: AuthConfigSchema.describe('Authentication and authorization'),
  databases: DatabasesConfigSchema.describe('Database connections'),
  tables: z.array(z.any()).describe('Tracked tables (populated from metadata)'),
  trackedFunctions: z.array(TrackedFunctionConfigSchema).default([]).describe('Tracked SQL functions'),
  actions: z.array(ActionConfigSchema).describe('Action definitions'),
  actionsGraphql: z.string().optional().describe('Raw GraphQL SDL for action custom types'),
  cronTriggers: z.array(CronTriggerConfigSchema).describe('Cron trigger definitions'),
  rest: RESTConfigSchema.describe('REST API settings'),
  queryCollections: z.array(QueryCollectionSchema).default([]).describe('Query collections'),
  hasuraRestEndpoints: z.array(HasuraRestEndpointSchema).default([]).describe('Hasura-style REST endpoints'),
  nativeQueries: z.array(NativeQuerySchema).default([]).describe('Native query definitions'),
  logicalModels: z.array(LogicalModelSchema).default([]).describe('Logical model definitions'),
  apiDocs: APIDocsConfigSchema.describe('API documentation settings'),
  inheritedRoles: z.record(z.string(), z.array(z.string())).default({}).describe('Inherited roles — role name to list of parent roles'),
  jobQueue: JobQueueConfigSchema.optional().describe('Job queue configuration'),
  redis: RedisConfigSchema.optional().describe('Redis connection'),
  eventLogRetentionDays: z.number().default(7).describe('Days to retain event log entries'),
  slowQueryThresholdMs: z.number().default(200).describe('Milliseconds above which a query is logged as slow'),
  queryCache: z.object({
    maxSize: z.number().default(1000).describe('Maximum cached query plans'),
  }).default({ maxSize: 1000 }).describe('Query plan cache'),
  subscriptions: z.object({
    debounceMs: z.number().default(50).describe('Milliseconds to debounce subscription polls'),
    keepAliveMs: z.number().default(30000).describe('Milliseconds between WebSocket keep-alive pings'),
  }).default({ debounceMs: 50, keepAliveMs: 30000 }).describe('Subscription settings'),
  eventDelivery: z.object({
    batchSize: z.number().default(100).describe('Events fetched per delivery batch'),
    httpConcurrency: z.number().default(1).describe('Concurrent webhook delivery requests'),
  }).default({ batchSize: 100, httpConcurrency: 1 }).describe('Event delivery tuning'),
  eventCleanup: z.object({
    schedule: z.string().default('0 3 * * *').describe('Cron expression for cleanup schedule'),
  }).default({ schedule: '0 3 * * *' }).describe('Event log cleanup'),
  webhook: z.object({
    timeoutMs: z.number().default(30000).describe('Webhook request timeout in milliseconds'),
    backoffCapSeconds: z.number().default(3600).describe('Maximum retry backoff in seconds'),
    allowPrivateUrls: z.boolean().default(false).describe('Allow webhooks to private/internal URLs'),
    maxResponseBytes: z.number().default(1048576).describe('Maximum webhook response size in bytes'),
  }).default({ timeoutMs: 30000, backoffCapSeconds: 3600, allowPrivateUrls: false, maxResponseBytes: 1048576 }).describe('Global webhook settings'),
  actionDefaults: z.object({
    timeoutSeconds: z.number().default(30).describe('Default sync action timeout in seconds'),
    asyncRetryLimit: z.number().default(3).describe('Default async action retry limit'),
    asyncRetryDelaySeconds: z.number().default(10).describe('Default delay between async retries'),
    asyncTimeoutSeconds: z.number().default(120).describe('Default async action timeout in seconds'),
  }).default({ timeoutSeconds: 30, asyncRetryLimit: 3, asyncRetryDelaySeconds: 10, asyncTimeoutSeconds: 120 }).describe('Default action settings'),
  graphql: z.object({
    queryDepth: z.number().default(10).describe('Maximum query nesting depth'),
    maxLimit: z.number().default(100).describe('Maximum rows per query'),
    maxBatchSize: z.number().default(10).describe('Maximum operations per batch request'),
  }).default({ queryDepth: 10, maxLimit: 100, maxBatchSize: 10 }).describe('GraphQL engine settings'),
  sql: z.object({
    arrayAnyThreshold: z.number().default(20).describe('Values above which IN lists use ANY(ARRAY[...])'),
    unnestThreshold: z.number().default(500).describe('Values above which IN lists use UNNEST'),
    batchChunkSize: z.number().default(100).describe('Rows per chunk for batch operations'),
  }).default({ arrayAnyThreshold: 20, unnestThreshold: 500, batchChunkSize: 100 }).describe('SQL generation tuning'),
  introspection: IntrospectionConfigSchema.default({ disabledForRoles: [] }).describe('Introspection access control'),
  schema: z.object({
    defaultOperations: OperationsConfigSchema.default({
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
    }).describe('Default CRUD operations for all tables'),
  }).default({
    defaultOperations: {
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
    },
  }).describe('Schema generation settings'),
}).describe('Top-level Hakkyra configuration');

// ---------------------------------------------------------------------------
// CONFIG_DEFAULTS — file-system / watcher defaults not covered by Zod schemas
// ---------------------------------------------------------------------------

export const CONFIG_DEFAULTS = {
  configPath: './hakkyra.yaml',
  metadataPath: './metadata',
  configWatcherDebounceMs: 500,
} as const;
