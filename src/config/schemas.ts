/**
 * Zod schemas for raw YAML types, mirroring the interfaces in types.ts.
 */

import { z } from 'zod';

// ─── Hasura metadata version ────────────────────────────────────────────────

export const RawVersionYamlSchema = z
  .object({
    version: z.number(),
  })
  .strict();

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
  .strict();

const ReadReplicaPoolSettingsSchema = z
  .object({
    max_connections: z.number().optional(),
    idle_timeout: z.number().optional(),
    connection_lifetime: z.number().optional(),
    retries: z.number().optional(),
  })
  .strict();

const ConnectionInfoSchema = z
  .object({
    database_url: DatabaseUrlSchema.optional(),
    pool_settings: PoolSettingsSchema.optional(),
    isolation_level: z.string().optional(),
    use_prepared_statements: z.boolean().optional(),
  })
  .strict();

const ReadReplicaSchema = z
  .object({
    database_url: DatabaseUrlSchema.optional(),
    pool_settings: ReadReplicaPoolSettingsSchema.optional(),
  })
  .strict();

const TableIdentifierSchema = z.object({
  schema: z.string(),
  name: z.string(),
});

export const RawTableReferenceSchema = z
  .object({
    table: TableIdentifierSchema,
  })
  .strict();

// ─── Logical Models & Native Queries (Hasura v2.28+) ────────────────────────

const RawLogicalModelFieldTypeSchema = z
  .object({
    nullable: z.boolean().optional(),
    scalar: z.string(),
  })
  .strict();

const RawLogicalModelFieldSchema = z
  .object({
    name: z.string(),
    type: RawLogicalModelFieldTypeSchema,
  })
  .strict();

const RawLogicalModelPermissionSchema = z
  .object({
    permission: z
      .object({
        columns: z.array(z.string()),
        filter: z.record(z.string(), z.unknown()),
      })
      .strict(),
    role: z.string(),
  })
  .strict();

export const RawLogicalModelSchema = z
  .object({
    name: z.string(),
    fields: z.array(RawLogicalModelFieldSchema),
    select_permissions: z.array(RawLogicalModelPermissionSchema).optional(),
  })
  .strict();

const RawNativeQueryArgumentSchema = z
  .object({
    nullable: z.boolean().optional(),
    type: z.string(),
    description: z.string().optional(),
  })
  .strict();

export const RawNativeQuerySchema = z
  .object({
    arguments: z.record(z.string(), RawNativeQueryArgumentSchema).optional(),
    code: z.string(),
    returns: z.string(),
    root_field_name: z.string(),
  })
  .strict();

export const RawDatabaseEntrySchema = z
  .object({
    name: z.string(),
    kind: z.string(),
    configuration: z
      .object({
        connection_info: ConnectionInfoSchema,
        read_replicas: z.array(ReadReplicaSchema).optional(),
      })
      .strict(),
    tables: z.unknown(),  // may be IncludeRef, string, or array — resolved downstream
    functions: z.unknown().optional(),  // may be IncludeRef, string, or array — resolved via loadAllFunctions
    native_queries: z.array(RawNativeQuerySchema).optional(),
    logical_models: z.array(RawLogicalModelSchema).optional(),
  })
  .strict();

export const RawDatabasesYamlSchema = z
  .object({
    databases: z.array(RawDatabaseEntrySchema).optional(),
  })
  .strict();

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
      .strict(),
    comment: z.string().optional(),
  })
  .strict();

export const RawRelationshipSchema = z
  .object({
    name: z.string(),
    using: z
      .object({
        foreign_key_constraint_on: z
          .union([
            z.string(),
            z.array(z.string()),
            z.object({
              column: z.string().optional(),
              columns: z.array(z.string()).optional(),
              table: z.union([TableIdentifierSchema, z.string()]).optional(),
            }).strict(),
          ])
          .optional(),
        manual_configuration: z
          .object({
            remote_table: TableIdentifierSchema,
            column_mapping: z.record(z.string(), z.string()),
            insertion_order: z.enum(['before_parent', 'after_parent']).nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

// ─── Permissions ────────────────────────────────────────────────────────────

export const RawSelectPermissionSchema = z
  .object({
    columns: ColumnsSchema,
    filter: BoolExpSchema,
    limit: z.number().optional(),
    allow_aggregations: z.boolean().optional(),
    computed_fields: z.array(z.string()).optional(),
    query_root_fields: z.array(z.string()).optional(),
    subscription_root_fields: z.array(z.string()).optional(),
  })
  .strict();

export const RawInsertPermissionSchema = z
  .object({
    columns: ColumnsSchema,
    check: BoolExpSchema,
    set: z.record(z.string(), z.string()).optional(),
    backend_only: z.boolean().optional(),
  })
  .strict();

export const RawUpdatePermissionSchema = z
  .object({
    columns: ColumnsSchema,
    filter: BoolExpSchema,
    check: BoolExpSchema.nullable().optional(),
    set: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const RawDeletePermissionSchema = z
  .object({
    filter: BoolExpSchema,
  })
  .strict();

function permissionEntrySchema<T extends z.ZodTypeAny>(permSchema: T) {
  return z
    .object({
      role: z.string(),
      permission: permSchema,
      comment: z.string().optional(),
      backend_only: z.boolean().optional(),
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
    name: z.string(),
    value: z.string().optional(),
    value_from_env: z.string().optional(),
  })
  .strict();

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
      .strict(),
    retry_conf: z
      .object({
        interval_sec: z.number().optional(),
        num_retries: z.number().optional(),
        timeout_sec: z.number().optional(),
      })
      .strict(),
    webhook: z.string().optional(),
    webhook_from_env: z.string().optional(),
    headers: z.array(RawHeaderSchema).optional(),
    concurrency: z.number().optional(),
  })
  .strict();

// ─── Table YAML (full) ─────────────────────────────────────────────────────

export const RawTableYamlSchema = z
  .object({
    table: TableIdentifierSchema,
    configuration: z
      .object({
        custom_root_fields: z.record(z.string(), z.string()).optional(),
        custom_column_names: z.record(z.string(), z.string()).optional(),
        column_config: z.record(z.string(), z.object({
          custom_name: z.string().optional(),
          comment: z.string().optional(),
        }).strict()).optional(),
        custom_name: z.string().optional(),
        comment: z.string().optional(),
      })
      .strict()
      .optional(),
    object_relationships: z.array(RawRelationshipSchema).optional(),
    array_relationships: z.array(RawRelationshipSchema).optional(),
    computed_fields: z.array(RawComputedFieldSchema).optional(),
    select_permissions: z.array(RawSelectPermissionEntrySchema).optional(),
    insert_permissions: z.array(RawInsertPermissionEntrySchema).optional(),
    update_permissions: z.array(RawUpdatePermissionEntrySchema).optional(),
    delete_permissions: z.array(RawDeletePermissionEntrySchema).optional(),
    event_triggers: z.array(RawEventTriggerSchema).optional(),
    is_enum: z.boolean().optional(),
  })
  .strict();

// ─── Actions ────────────────────────────────────────────────────────────────

const RequestTransformSchema = z
  .object({
    method: z.string().optional(),
    url: z.string().optional(),
    body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    content_type: z.string().optional(),
    query_params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    template_engine: z.string().optional(),
    version: z.number().optional(),
  })
  .strict();

const ResponseTransformSchema = z
  .object({
    body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  })
  .strict();

const ActionRelationshipSchema = z
  .object({
    name: z.string(),
    type: z.enum(['object', 'array']),
    remote_table: z.union([TableIdentifierSchema, z.string()]),
    field_mapping: z.record(z.string(), z.string()),
  })
  .strict();

export const RawActionSchema = z
  .object({
    name: z.string(),
    definition: z
      .object({
        kind: z.string().optional(),
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
      .strict(),
    permissions: z.array(z.object({ role: z.string() }).strict()).optional(),
    relationships: z.array(ActionRelationshipSchema).optional(),
    comment: z.string().optional(),
  })
  .strict();

export const RawActionsYamlSchema = z
  .object({
    actions: z.array(RawActionSchema).optional(),
    custom_types: z.unknown().optional(),
  })
  .strict();

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
      .strict()
      .optional(),
    headers: z.array(RawHeaderSchema).optional(),
    include_in_metadata: z.boolean().optional(),
    comment: z.string().optional(),
  })
  .strict();

// ─── Hakkyra extension: api_config.yaml ─────────────────────────────────────

export const RawRESTOverrideSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string(),
    operation: z.string(),
    default_order: z.string().optional(),
  })
  .strict();

export const RawApiConfigSchema = z
  .object({
    rest: z
      .object({
        auto_generate: z.boolean().optional(),
        base_path: z.string().optional(),
        pagination: z
          .object({
            default_limit: z.number().optional(),
            max_limit: z.number().optional(),
          })
          .strict()
          .optional(),
        overrides: z.record(z.string(), z.array(RawRESTOverrideSchema)).optional(),
      })
      .strict()
      .optional(),
    docs: z
      .object({
        generate: z.boolean().optional(),
        output: z.string().optional(),
        llm_format: z.boolean().optional(),
        include_examples: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ─── Query Collections ──────────────────────────────────────────────────

export const RawQueryCollectionQuerySchema = z
  .object({
    name: z.string(),
    query: z.string(),
  })
  .strict();

export const RawQueryCollectionSchema = z
  .object({
    name: z.string(),
    definition: z
      .object({
        queries: z.array(RawQueryCollectionQuerySchema),
      })
      .strict(),
  })
  .strict();

// ─── REST Endpoints (Hasura-style) ──────────────────────────────────────

export const RawHasuraRestEndpointSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    methods: z.array(z.string()),
    definition: z
      .object({
        query: z.object({
          collection_name: z.string(),
          query_name: z.string(),
        }),
      })
      .strict(),
    comment: z.string().optional(),
  })
  .strict();

// ─── Introspection Control ──────────────────────────────────────────────

export const RawIntrospectionConfigSchema = z
  .object({
    disabled_for_roles: z.array(z.string()).optional(),
  })
  .strict();

// ─── Tracked Functions ──────────────────────────────────────────────────

export const RawTrackedFunctionSchema = z
  .object({
    function: z.object({
      name: z.string(),
      schema: z.string().optional(),
    }),
    configuration: z
      .object({
        exposed_as: z.enum(['query', 'mutation']).optional(),
        custom_root_fields: z
          .object({
            function: z.string().optional(),
            function_aggregate: z.string().optional(),
          })
          .strict()
          .optional(),
        session_argument: z.string().optional(),
      })
      .strict()
      .optional(),
    permissions: z
      .array(z.object({ role: z.string() }).strict())
      .optional(),
  })
  .strict();

// ─── Server config (standalone) ─────────────────────────────────────────────

const DbPoolSchema = z
  .object({
    max: z.number().optional(),
    idle_timeout: z.number().optional(),
    connection_timeout: z.number().optional(),
    max_lifetime: z.number().optional(),
    allow_exit_on_idle: z.boolean().optional(),
  })
  .strict();

const DbConnectionSchema = z
  .object({
    url_from_env: z.string().optional(),
    pool: DbPoolSchema.optional(),
  })
  .strict();

export const RawServerConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().optional(),
        host: z.string().optional(),
        slow_query_threshold_ms: z.number().optional(),
        log_level: z.string().optional(),
        stringify_numeric_types: z.boolean().optional(),
        body_limit: z.number().optional(),
        schema_name: z.string().optional(),
      })
      .strict()
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
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    event_log: z
      .object({
        retention_days: z.number().optional(),
      })
      .strict()
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
                  .strict(),
              )
              .optional(),
            audience: z.string().optional(),
            issuer: z.string().optional(),
            require_exp: z.boolean().optional(),
            admin_role_is_admin: z.boolean().optional(),
          })
          .strict()
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
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    databases: z
      .object({
        primary: DbConnectionSchema.optional(),
        replicas: z.array(DbConnectionSchema).optional(),
        session: z
          .object({
            url_from_env: z.string().optional(),
          })
          .strict()
          .optional(),
        read_your_writes: z
          .object({
            enabled: z.boolean().optional(),
            window_seconds: z.number().optional(),
          })
          .strict()
          .optional(),
        prepared_statements: z
          .object({
            enabled: z.boolean().optional(),
            max_cached: z.number().optional(),
          })
          .strict()
          .optional(),
        subscription_query_routing: z.enum(['primary', 'replica']).optional(),
      })
      .strict()
      .optional(),
    redis: z
      .object({
        url: z.string().optional(),
        host: z.string().optional(),
        port: z.number().optional(),
        password: z.string().optional(),
      })
      .strict()
      .optional(),
    query_cache: z
      .object({
        max_size: z.number().optional(),
      })
      .strict()
      .optional(),
    subscriptions: z
      .object({
        debounce_ms: z.number().optional(),
        keep_alive_ms: z.number().optional(),
      })
      .strict()
      .optional(),
    event_delivery: z
      .object({
        batch_size: z.number().optional(),
        http_concurrency: z.number().optional(),
      })
      .strict()
      .optional(),
    event_cleanup: z
      .object({
        schedule: z.string().optional(),
      })
      .strict()
      .optional(),
    webhook: z
      .object({
        timeout_ms: z.number().optional(),
        backoff_cap_seconds: z.number().optional(),
        allow_private_urls: z.boolean().optional(),
        max_response_bytes: z.number().optional(),
      })
      .strict()
      .optional(),
    action_defaults: z
      .object({
        timeout_seconds: z.number().optional(),
        async_retry_limit: z.number().optional(),
        async_retry_delay_seconds: z.number().optional(),
        async_timeout_seconds: z.number().optional(),
      })
      .strict()
      .optional(),
    graphql: z
      .object({
        query_depth: z.number().optional(),
        max_limit: z.number().optional(),
        max_batch_size: z.number().optional(),
      })
      .strict()
      .optional(),
    sql: z
      .object({
        array_any_threshold: z.number().optional(),
        unnest_threshold: z.number().optional(),
        batch_chunk_size: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
