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

export const RelationshipTypeSchema = z.enum(['object', 'array']);

export const RelationshipConfigSchema = z.object({
  name: z.string(),
  type: RelationshipTypeSchema,
  remoteTable: z.object({
    name: z.string(),
    schema: z.string(),
  }),
  localColumns: z.array(z.string()).optional(),
  remoteColumns: z.array(z.string()).optional(),
  columnMapping: z.record(z.string(), z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const columnsSchema = z.union([z.array(z.string()), z.literal('*')]);

export const SelectPermissionSchema = z.object({
  columns: columnsSchema,
  filter: BoolExpSchema,
  limit: z.number().optional(),
  allowAggregations: z.boolean().optional(),
  computedFields: z.array(z.string()).optional(),
});

export const InsertPermissionSchema = z.object({
  columns: columnsSchema,
  check: BoolExpSchema,
  set: z.record(z.string(), z.string()).optional(),
  backendOnly: z.boolean().optional(),
});

export const UpdatePermissionSchema = z.object({
  columns: columnsSchema,
  filter: BoolExpSchema,
  check: BoolExpSchema.optional(),
  set: z.record(z.string(), z.string()).optional(),
});

export const DeletePermissionSchema = z.object({
  filter: BoolExpSchema,
});

export const TablePermissionsSchema = z.object({
  select: z.record(z.string(), SelectPermissionSchema),
  insert: z.record(z.string(), InsertPermissionSchema),
  update: z.record(z.string(), UpdatePermissionSchema),
  delete: z.record(z.string(), DeletePermissionSchema),
});

// ---------------------------------------------------------------------------
// CustomRootFields
// ---------------------------------------------------------------------------

export const CustomRootFieldsSchema = z.object({
  select: z.string().optional(),
  select_by_pk: z.string().optional(),
  select_aggregate: z.string().optional(),
  select_stream: z.string().optional(),
  insert: z.string().optional(),
  insert_one: z.string().optional(),
  update: z.string().optional(),
  update_by_pk: z.string().optional(),
  delete: z.string().optional(),
  delete_by_pk: z.string().optional(),
});

// ---------------------------------------------------------------------------
// WebhookHeader
// ---------------------------------------------------------------------------

export const WebhookHeaderSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  valueFromEnv: z.string().optional(),
});

// ---------------------------------------------------------------------------
// EventTriggerConfig
// ---------------------------------------------------------------------------

const eventTriggerOperationSchema = z.object({
  columns: columnsSchema,
});

export const EventTriggerConfigSchema = z.object({
  name: z.string(),
  definition: z.object({
    enableManual: z.boolean().optional(),
    insert: eventTriggerOperationSchema.optional(),
    update: eventTriggerOperationSchema.optional(),
    delete: eventTriggerOperationSchema.optional(),
  }),
  retryConf: z.object({
    intervalSec: z.number(),
    numRetries: z.number(),
    timeoutSec: z.number(),
  }),
  webhook: z.string(),
  webhookFromEnv: z.string().optional(),
  headers: z.array(WebhookHeaderSchema).optional(),
});

// ---------------------------------------------------------------------------
// CronTriggerConfig
// ---------------------------------------------------------------------------

export const CronTriggerConfigSchema = z.object({
  name: z.string(),
  webhook: z.string(),
  webhookFromEnv: z.string().optional(),
  schedule: z.string(),
  payload: z.unknown().optional(),
  retryConf: z
    .object({
      numRetries: z.number(),
      retryIntervalSeconds: z.number(),
      timeoutSeconds: z.number(),
      toleranceSeconds: z.number().optional(),
    })
    .optional(),
  headers: z.array(WebhookHeaderSchema).optional(),
  comment: z.string().optional(),
});

// ---------------------------------------------------------------------------
// RequestTransform / ResponseTransform
// ---------------------------------------------------------------------------

export const RequestTransformSchema = z.object({
  method: z.string().optional(),
  url: z.string().optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  contentType: z.string().optional(),
  queryParams: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const ResponseTransformSchema = z.object({
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});

// ---------------------------------------------------------------------------
// ActionRelationship
// ---------------------------------------------------------------------------

export const ActionRelationshipSchema = z.object({
  name: z.string(),
  type: z.enum(['object', 'array']),
  remoteTable: z.object({
    schema: z.string(),
    name: z.string(),
  }),
  fieldMapping: z.record(z.string(), z.string()),
});

// ---------------------------------------------------------------------------
// ActionConfig
// ---------------------------------------------------------------------------

export const ActionConfigSchema = z.object({
  name: z.string(),
  definition: z.object({
    kind: z.enum(['synchronous', 'asynchronous']).default('synchronous'),
    type: z.enum(['query', 'mutation']).default('mutation'),
    handler: z.string(),
    handlerFromEnv: z.string().optional(),
    forwardClientHeaders: z.boolean().optional(),
    headers: z.array(WebhookHeaderSchema).optional(),
    timeout: z.number().optional(),
  }),
  requestTransform: RequestTransformSchema.optional(),
  responseTransform: ResponseTransformSchema.optional(),
  permissions: z.array(z.object({ role: z.string() })).optional(),
  relationships: z.array(ActionRelationshipSchema).optional(),
  comment: z.string().optional(),
});

// ---------------------------------------------------------------------------
// REST config
// ---------------------------------------------------------------------------

export const RESTEndpointOverrideSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string(),
  operation: z.string(),
  defaultOrder: z.string().optional(),
});

export const RESTConfigSchema = z.object({
  autoGenerate: z.boolean().default(true),
  basePath: z.string().default('/api'),
  pagination: z.object({
    defaultLimit: z.number().default(20),
    maxLimit: z.number().default(100),
  }).default({ defaultLimit: 20, maxLimit: 100 }),
  overrides: z.record(z.string(), z.array(RESTEndpointOverrideSchema)).optional(),
});

// ---------------------------------------------------------------------------
// CustomQueryConfig
// ---------------------------------------------------------------------------

export const CustomQueryConfigSchema = z.object({
  name: z.string(),
  type: z.enum(['query', 'mutation']),
  sql: z.string(),
  params: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
      }),
    )
    .optional(),
  returns: z.string(),
  permissions: z
    .array(
      z.object({
        role: z.string(),
        filter: BoolExpSchema.optional(),
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// APIDocsConfig
// ---------------------------------------------------------------------------

export const APIDocsConfigSchema = z.object({
  generate: z.boolean(),
  output: z.string().optional(),
  llmFormat: z.boolean().optional(),
  includeExamples: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// JobQueueConfig
// ---------------------------------------------------------------------------

export const JobQueueProviderSchema = z.enum(['pg-boss', 'bullmq']);

export const JobQueueConfigSchema = z.object({
  provider: JobQueueProviderSchema.default('pg-boss'),
  connectionString: z.string().optional(),
  redis: z
    .object({
      url: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      password: z.string().optional(),
    })
    .optional(),
  gracefulShutdownMs: z.number().default(10000),
});

// ---------------------------------------------------------------------------
// AuthConfig
// ---------------------------------------------------------------------------

export const AuthConfigSchema = z.object({
  jwt: z
    .object({
      type: z.string().default('HS256'),
      key: z.string().optional(),
      keyEnv: z.string().optional(),
      jwkUrl: z.string().optional(),
      claimsNamespace: z.string().optional(),
      claimsMap: z
        .record(
          z.string(),
          z.object({
            path: z.string(),
            default: z.string().optional(),
          }),
        )
        .optional(),
      audience: z.string().optional(),
      issuer: z.string().optional(),
    })
    .optional(),
  adminSecretEnv: z.string().optional(),
  unauthorizedRole: z.string().optional(),
  webhook: z
    .object({
      url: z.string(),
      urlFromEnv: z.string().optional(),
      mode: z.enum(['GET', 'POST']).default('GET'),
      forwardHeaders: z.boolean().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// RedisConfig
// ---------------------------------------------------------------------------

export const RedisConfigSchema = z.object({
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().default(6379),
  password: z.string().optional(),
});

// ---------------------------------------------------------------------------
// DatabasesConfig / PoolConfig
// ---------------------------------------------------------------------------

export const PoolConfigSchema = z.object({
  max: z.number().default(10),
  idleTimeout: z.number().default(30),
  connectionTimeout: z.number().default(5),
  maxLifetime: z.number().optional(),
  allowExitOnIdle: z.boolean().optional(),
});

export const DatabasesConfigSchema = z.object({
  primary: z.object({
    urlEnv: z.string(),
    pool: PoolConfigSchema.optional(),
  }),
  replicas: z
    .array(
      z.object({
        urlEnv: z.string(),
        pool: PoolConfigSchema.optional(),
      }),
    )
    .optional(),
  session: z
    .object({
      urlEnv: z.string(),
    })
    .optional(),
  readYourWrites: z
    .object({
      enabled: z.boolean().default(false),
      windowSeconds: z.number().default(5),
    })
    .optional(),
  preparedStatements: z
    .object({
      enabled: z.boolean(),
      maxCached: z.number().optional(),
    })
    .optional(),
  subscriptionQueryRouting: z.enum(['primary', 'replica']).optional(),
});

// ---------------------------------------------------------------------------
// ComputedFieldConfig
// ---------------------------------------------------------------------------

export const ComputedFieldConfigSchema = z.object({
  name: z.string(),
  function: z.object({
    name: z.string(),
    schema: z.string().optional(),
  }),
  tableArgument: z.string().optional(),
  sessionArgument: z.string().optional(),
  comment: z.string().optional(),
});

// ---------------------------------------------------------------------------
// TrackedFunctionConfig
// ---------------------------------------------------------------------------

export const TrackedFunctionConfigSchema = z.object({
  name: z.string(),
  schema: z.string().default('public'),
  exposedAs: z.enum(['query', 'mutation']).default('query'),
  customRootFields: z.object({
    function: z.string().optional(),
    functionAggregate: z.string().optional(),
  }).optional(),
  sessionArgument: z.string().optional(),
  permissions: z.array(z.object({ role: z.string() })).optional(),
});

// ---------------------------------------------------------------------------
// HakkyraConfig (top-level)
// ---------------------------------------------------------------------------

export const HakkyraConfigSchema = z.object({
  version: z.number(),
  server: z.object({
    port: z.number().default(3000),
    host: z.string().default('0.0.0.0'),
    logLevel: z.string().default('info'),
    stringifyNumericTypes: z.boolean().default(false),
  }).default({ port: 3000, host: '0.0.0.0', logLevel: 'info', stringifyNumericTypes: false }),
  auth: AuthConfigSchema,
  databases: DatabasesConfigSchema,
  tables: z.array(z.any()), // TableInfo contains introspection data — not validated
  trackedFunctions: z.array(TrackedFunctionConfigSchema).default([]),
  actions: z.array(ActionConfigSchema),
  actionsGraphql: z.string().optional(),
  cronTriggers: z.array(CronTriggerConfigSchema),
  rest: RESTConfigSchema,
  customQueries: z.array(CustomQueryConfigSchema),
  apiDocs: APIDocsConfigSchema,
  tableAliases: z.record(z.string(), z.string()),
  inheritedRoles: z.record(z.string(), z.array(z.string())).default({}),
  jobQueue: JobQueueConfigSchema.optional(),
  redis: RedisConfigSchema.optional(),
  eventLogRetentionDays: z.number().default(7),
  slowQueryThresholdMs: z.number().default(200),
  queryCache: z.object({
    maxSize: z.number().default(1000),
  }).default({ maxSize: 1000 }),
  subscriptions: z.object({
    debounceMs: z.number().default(50),
    keepAliveMs: z.number().default(30000),
  }).default({ debounceMs: 50, keepAliveMs: 30000 }),
  eventDelivery: z.object({
    batchSize: z.number().default(100),
  }).default({ batchSize: 100 }),
  eventCleanup: z.object({
    schedule: z.string().default('0 3 * * *'),
  }).default({ schedule: '0 3 * * *' }),
  webhook: z.object({
    timeoutMs: z.number().default(30000),
    backoffCapSeconds: z.number().default(3600),
  }).default({ timeoutMs: 30000, backoffCapSeconds: 3600 }),
  actionDefaults: z.object({
    timeoutSeconds: z.number().default(30),
    asyncRetryLimit: z.number().default(3),
    asyncRetryDelaySeconds: z.number().default(10),
    asyncTimeoutSeconds: z.number().default(120),
  }).default({ timeoutSeconds: 30, asyncRetryLimit: 3, asyncRetryDelaySeconds: 10, asyncTimeoutSeconds: 120 }),
  sql: z.object({
    arrayAnyThreshold: z.number().default(20),
    unnestThreshold: z.number().default(500),
    batchChunkSize: z.number().default(100),
  }).default({ arrayAnyThreshold: 20, unnestThreshold: 500, batchChunkSize: 100 }),
});

// ---------------------------------------------------------------------------
// CONFIG_DEFAULTS — file-system / watcher defaults not covered by Zod schemas
// ---------------------------------------------------------------------------

export const CONFIG_DEFAULTS = {
  configPath: './hakkyra.yaml',
  metadataPath: './metadata',
  configWatcherDebounceMs: 500,
} as const;
