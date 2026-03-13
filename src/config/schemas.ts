/**
 * Zod schemas for raw YAML types, mirroring the interfaces in types.ts.
 */

import { z } from 'zod';

// ─── Hasura metadata version ────────────────────────────────────────────────

export const RawVersionYamlSchema = z
  .object({
    version: z.number(),
  })
  .passthrough();

// ─── Database configuration ─────────────────────────────────────────────────

const DatabaseUrlSchema = z.union([
  z.string(),
  z.object({ from_env: z.string() }),
]);

const PoolSettingsSchema = z
  .object({
    max_connections: z.number().optional(),
    idle_timeout: z.number().optional(),
    connection_lifetime: z.number().optional(),
    retries: z.number().optional(),
  })
  .passthrough();

const ReadReplicaPoolSettingsSchema = z
  .object({
    max_connections: z.number().optional(),
    idle_timeout: z.number().optional(),
    connection_lifetime: z.number().optional(),
    retries: z.number().optional(),
  })
  .passthrough();

const ConnectionInfoSchema = z
  .object({
    database_url: DatabaseUrlSchema.optional(),
    pool_settings: PoolSettingsSchema.optional(),
    isolation_level: z.string().optional(),
    use_prepared_statements: z.boolean().optional(),
  })
  .passthrough();

const ReadReplicaSchema = z
  .object({
    database_url: DatabaseUrlSchema.optional(),
    pool_settings: ReadReplicaPoolSettingsSchema.optional(),
  })
  .passthrough();

const TableIdentifierSchema = z.object({
  schema: z.string(),
  name: z.string(),
});

export const RawTableReferenceSchema = z
  .object({
    table: TableIdentifierSchema,
  })
  .passthrough();

export const RawDatabaseEntrySchema = z
  .object({
    name: z.string(),
    kind: z.string(),
    configuration: z
      .object({
        connection_info: ConnectionInfoSchema,
        read_replicas: z.array(ReadReplicaSchema).optional(),
      })
      .passthrough(),
    tables: z.unknown(),  // may be IncludeRef, string, or array — resolved downstream
  })
  .passthrough();

export const RawDatabasesYamlSchema = z
  .object({
    databases: z.array(RawDatabaseEntrySchema).optional(),
  })
  .passthrough();

// ─── Table configuration ────────────────────────────────────────────────────

const ColumnsSchema = z.union([z.array(z.string()), z.literal('*')]);

const BoolExpSchema = z.record(z.string(), z.unknown());

export const RawComputedFieldSchema = z
  .object({
    name: z.string(),
    definition: z
      .object({
        function: z.object({
          name: z.string(),
          schema: z.string().optional(),
        }),
        table_argument: z.string().optional(),
        session_argument: z.string().optional(),
      })
      .passthrough(),
    comment: z.string().optional(),
  })
  .passthrough();

export const RawRelationshipSchema = z
  .object({
    name: z.string(),
    using: z
      .object({
        foreign_key_constraint_on: z
          .union([
            z.string(),
            z.object({
              column: z.string(),
              table: TableIdentifierSchema,
            }),
          ])
          .optional(),
        manual_configuration: z
          .object({
            remote_table: TableIdentifierSchema,
            column_mapping: z.record(z.string(), z.string()),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

// ─── Permissions ────────────────────────────────────────────────────────────

export const RawSelectPermissionSchema = z
  .object({
    columns: ColumnsSchema,
    filter: BoolExpSchema,
    limit: z.number().optional(),
    allow_aggregations: z.boolean().optional(),
    computed_fields: z.array(z.string()).optional(),
  })
  .passthrough();

export const RawInsertPermissionSchema = z
  .object({
    columns: ColumnsSchema,
    check: BoolExpSchema,
    set: z.record(z.string(), z.string()).optional(),
    backend_only: z.boolean().optional(),
  })
  .passthrough();

export const RawUpdatePermissionSchema = z
  .object({
    columns: ColumnsSchema,
    filter: BoolExpSchema,
    check: BoolExpSchema.optional(),
    set: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const RawDeletePermissionSchema = z
  .object({
    filter: BoolExpSchema,
  })
  .passthrough();

function permissionEntrySchema<T extends z.ZodTypeAny>(permSchema: T) {
  return z
    .object({
      role: z.string(),
      permission: permSchema,
      comment: z.string().optional(),
    })
    .passthrough();
}

export const RawSelectPermissionEntrySchema = permissionEntrySchema(RawSelectPermissionSchema);
export const RawInsertPermissionEntrySchema = permissionEntrySchema(RawInsertPermissionSchema);
export const RawUpdatePermissionEntrySchema = permissionEntrySchema(RawUpdatePermissionSchema);
export const RawDeletePermissionEntrySchema = permissionEntrySchema(RawDeletePermissionSchema);

// ─── Event triggers ─────────────────────────────────────────────────────────

export const RawHeaderSchema = z
  .object({
    name: z.string(),
    value: z.string().optional(),
    value_from_env: z.string().optional(),
  })
  .passthrough();

const EventTriggerColumnSpecSchema = z.object({
  columns: ColumnsSchema,
});

export const RawEventTriggerSchema = z
  .object({
    name: z.string(),
    definition: z
      .object({
        enable_manual: z.boolean().optional(),
        insert: EventTriggerColumnSpecSchema.optional(),
        update: EventTriggerColumnSpecSchema.optional(),
        delete: EventTriggerColumnSpecSchema.optional(),
      })
      .passthrough(),
    retry_conf: z
      .object({
        interval_sec: z.number().optional(),
        num_retries: z.number().optional(),
        timeout_sec: z.number().optional(),
      })
      .passthrough(),
    webhook: z.string().optional(),
    webhook_from_env: z.string().optional(),
    headers: z.array(RawHeaderSchema).optional(),
  })
  .passthrough();

// ─── Table YAML (full) ─────────────────────────────────────────────────────

export const RawTableYamlSchema = z
  .object({
    table: TableIdentifierSchema,
    configuration: z
      .object({
        custom_root_fields: z.record(z.string(), z.string()).optional(),
        custom_column_names: z.record(z.string(), z.string()).optional(),
        comment: z.string().optional(),
      })
      .passthrough()
      .optional(),
    object_relationships: z.array(RawRelationshipSchema).optional(),
    array_relationships: z.array(RawRelationshipSchema).optional(),
    computed_fields: z.array(RawComputedFieldSchema).optional(),
    select_permissions: z.array(RawSelectPermissionEntrySchema).optional(),
    insert_permissions: z.array(RawInsertPermissionEntrySchema).optional(),
    update_permissions: z.array(RawUpdatePermissionEntrySchema).optional(),
    delete_permissions: z.array(RawDeletePermissionEntrySchema).optional(),
    event_triggers: z.array(RawEventTriggerSchema).optional(),
  })
  .passthrough();

// ─── Actions ────────────────────────────────────────────────────────────────

const RequestTransformSchema = z
  .object({
    method: z.string().optional(),
    url: z.string().optional(),
    body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    content_type: z.string().optional(),
    query_params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const ResponseTransformSchema = z
  .object({
    body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  })
  .passthrough();

const ActionRelationshipSchema = z
  .object({
    name: z.string(),
    type: z.enum(['object', 'array']),
    remote_table: z.union([TableIdentifierSchema, z.string()]),
    field_mapping: z.record(z.string(), z.string()),
  })
  .passthrough();

export const RawActionSchema = z
  .object({
    name: z.string(),
    definition: z
      .object({
        kind: z.enum(['synchronous', 'asynchronous']).optional(),
        handler: z.string().optional(),
        handler_from_env: z.string().optional(),
        forward_client_headers: z.boolean().optional(),
        headers: z.array(RawHeaderSchema).optional(),
        timeout: z.number().optional(),
        type: z.string().optional(),
        arguments: z.array(z.unknown()).optional(),
        output_type: z.string().optional(),
        request_transform: RequestTransformSchema.optional(),
        response_transform: ResponseTransformSchema.optional(),
      })
      .passthrough(),
    permissions: z.array(z.object({ role: z.string() }).passthrough()).optional(),
    relationships: z.array(ActionRelationshipSchema).optional(),
    comment: z.string().optional(),
  })
  .passthrough();

export const RawActionsYamlSchema = z
  .object({
    actions: z.array(RawActionSchema).optional(),
    custom_types: z.unknown().optional(),
  })
  .passthrough();

// ─── Cron triggers ──────────────────────────────────────────────────────────

export const RawCronTriggerSchema = z
  .object({
    name: z.string(),
    webhook: z.string().optional(),
    webhook_from_env: z.string().optional(),
    schedule: z.string(),
    payload: z.unknown().optional(),
    retry_conf: z
      .object({
        num_retries: z.number().optional(),
        retry_interval_seconds: z.number().optional(),
        timeout_seconds: z.number().optional(),
        tolerance_seconds: z.number().optional(),
      })
      .passthrough()
      .optional(),
    headers: z.array(RawHeaderSchema).optional(),
    include_in_metadata: z.boolean().optional(),
    comment: z.string().optional(),
  })
  .passthrough();

// ─── Hakkyra extension: api_config.yaml ─────────────────────────────────────

export const RawRESTOverrideSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string(),
    operation: z.string(),
    default_order: z.string().optional(),
  })
  .passthrough();

export const RawCustomQuerySchema = z
  .object({
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
        z
          .object({
            role: z.string(),
            filter: BoolExpSchema.optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const RawApiConfigSchema = z
  .object({
    table_aliases: z.record(z.string(), z.string()).optional(),
    custom_queries: z.array(RawCustomQuerySchema).optional(),
    rest: z
      .object({
        auto_generate: z.boolean().optional(),
        base_path: z.string().optional(),
        pagination: z
          .object({
            default_limit: z.number().optional(),
            max_limit: z.number().optional(),
          })
          .passthrough()
          .optional(),
        overrides: z.record(z.string(), z.array(RawRESTOverrideSchema)).optional(),
      })
      .passthrough()
      .optional(),
    docs: z
      .object({
        generate: z.boolean().optional(),
        output: z.string().optional(),
        llm_format: z.boolean().optional(),
        include_examples: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ─── Server config (standalone) ─────────────────────────────────────────────

const DbPoolSchema = z
  .object({
    max: z.number().optional(),
    idle_timeout: z.number().optional(),
    connection_timeout: z.number().optional(),
    max_lifetime: z.number().optional(),
    allow_exit_on_idle: z.boolean().optional(),
  })
  .passthrough();

const DbConnectionSchema = z
  .object({
    url_from_env: z.string().optional(),
    pool: DbPoolSchema.optional(),
  })
  .passthrough();

export const RawServerConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().optional(),
        host: z.string().optional(),
        slow_query_threshold_ms: z.number().optional(),
      })
      .passthrough()
      .optional(),
    job_queue: z
      .object({
        provider: z.enum(['pg-boss', 'bullmq']).optional(),
        connection_string: z.string().optional(),
        redis: z
          .object({
            url: z.string().optional(),
            host: z.string().optional(),
            port: z.number().optional(),
            password: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    event_log: z
      .object({
        retention_days: z.number().optional(),
      })
      .passthrough()
      .optional(),
    auth: z
      .object({
        jwt: z
          .object({
            type: z.string().optional(),
            key: z.string().optional(),
            key_from_env: z.string().optional(),
            jwk_url: z.string().optional(),
            claims_namespace: z.string().optional(),
            claims_map: z
              .record(
                z.string(),
                z
                  .object({
                    path: z.string(),
                    default: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            audience: z.string().optional(),
            issuer: z.string().optional(),
          })
          .passthrough()
          .optional(),
        admin_secret_from_env: z.string().optional(),
        unauthorized_role: z.string().optional(),
        webhook: z
          .object({
            url: z.string().optional(),
            url_from_env: z.string().optional(),
            mode: z.enum(['GET', 'POST']).optional(),
            forward_headers: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    databases: z
      .object({
        primary: DbConnectionSchema.optional(),
        replicas: z.array(DbConnectionSchema).optional(),
        read_your_writes: z
          .object({
            enabled: z.boolean().optional(),
            window_seconds: z.number().optional(),
          })
          .passthrough()
          .optional(),
        prepared_statements: z
          .object({
            enabled: z.boolean().optional(),
            max_cached: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
