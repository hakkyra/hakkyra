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
    kind: z.enum(['synchronous', 'asynchronous']),
    type: z.enum(['query', 'mutation']),
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
  autoGenerate: z.boolean(),
  basePath: z.string(),
  pagination: z.object({
    defaultLimit: z.number(),
    maxLimit: z.number(),
  }),
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
  provider: JobQueueProviderSchema,
  connectionString: z.string().optional(),
  redis: z
    .object({
      url: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      password: z.string().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// AuthConfig
// ---------------------------------------------------------------------------

export const AuthConfigSchema = z.object({
  jwt: z
    .object({
      type: z.string(),
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
      mode: z.enum(['GET', 'POST']),
      forwardHeaders: z.boolean().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// DatabasesConfig / PoolConfig
// ---------------------------------------------------------------------------

export const PoolConfigSchema = z.object({
  max: z.number().optional(),
  idleTimeout: z.number().optional(),
  connectionTimeout: z.number().optional(),
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
  readYourWrites: z
    .object({
      enabled: z.boolean(),
      windowSeconds: z.number(),
    })
    .optional(),
  preparedStatements: z
    .object({
      enabled: z.boolean(),
      maxCached: z.number().optional(),
    })
    .optional(),
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
// HakkyraConfig (top-level)
// ---------------------------------------------------------------------------

export const HakkyraConfigSchema = z.object({
  version: z.number(),
  server: z.object({
    port: z.number(),
    host: z.string(),
  }),
  auth: AuthConfigSchema,
  databases: DatabasesConfigSchema,
  tables: z.array(z.any()), // TableInfo contains introspection data — not validated
  actions: z.array(ActionConfigSchema),
  actionsGraphql: z.string().optional(),
  cronTriggers: z.array(CronTriggerConfigSchema),
  rest: RESTConfigSchema,
  customQueries: z.array(CustomQueryConfigSchema),
  apiDocs: APIDocsConfigSchema,
  tableAliases: z.record(z.string(), z.string()),
  jobQueue: JobQueueConfigSchema.optional(),
  eventLogRetentionDays: z.number(),
  slowQueryThresholdMs: z.number(),
});
