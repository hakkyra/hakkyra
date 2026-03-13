/**
 * Raw YAML types representing Hasura metadata format before transformation.
 */

// ─── Hasura metadata version ────────────────────────────────────────────────

export interface RawVersionYaml {
  version: number;
}

// ─── Database configuration ─────────────────────────────────────────────────

export interface RawDatabaseEntry {
  name: string;
  kind: string;
  configuration: {
    connection_info: {
      database_url?: string | { from_env: string };
      pool_settings?: {
        max_connections?: number;
        idle_timeout?: number;
        connection_lifetime?: number;
        retries?: number;
      };
      isolation_level?: string;
      use_prepared_statements?: boolean;
    };
    read_replicas?: {
      database_url?: string | { from_env: string };
      pool_settings?: {
        max_connections?: number;
        idle_timeout?: number;
        connection_lifetime?: number;
      };
    }[];
  };
  tables: RawTableReference[] | string;
}

export interface RawDatabasesYaml {
  databases?: RawDatabaseEntry[];
}

// ─── Table configuration ────────────────────────────────────────────────────

export interface RawTableReference {
  table: { schema: string; name: string };
}

export interface RawTableYaml {
  table: { schema: string; name: string };
  configuration?: {
    custom_root_fields?: Record<string, string>;
    custom_column_names?: Record<string, string>;
    comment?: string;
  };
  object_relationships?: RawRelationship[];
  array_relationships?: RawRelationship[];
  computed_fields?: RawComputedField[];
  select_permissions?: RawPermissionEntry<RawSelectPermission>[];
  insert_permissions?: RawPermissionEntry<RawInsertPermission>[];
  update_permissions?: RawPermissionEntry<RawUpdatePermission>[];
  delete_permissions?: RawPermissionEntry<RawDeletePermission>[];
  event_triggers?: RawEventTrigger[];
}

export interface RawComputedField {
  name: string;
  definition: {
    function: {
      name: string;
      schema?: string;
    };
    table_argument?: string;
    session_argument?: string;
  };
  comment?: string;
}

export interface RawRelationship {
  name: string;
  using: {
    foreign_key_constraint_on?:
      | string
      | { column: string; table: { schema: string; name: string } };
    manual_configuration?: {
      remote_table: { schema: string; name: string };
      column_mapping: Record<string, string>;
    };
  };
}

// ─── Permissions ────────────────────────────────────────────────────────────

export interface RawPermissionEntry<T> {
  role: string;
  permission: T;
  comment?: string;
}

export interface RawSelectPermission {
  columns: string[] | '*';
  filter: Record<string, unknown>;
  limit?: number;
  allow_aggregations?: boolean;
  computed_fields?: string[];
}

export interface RawInsertPermission {
  columns: string[] | '*';
  check: Record<string, unknown>;
  set?: Record<string, string>;
  backend_only?: boolean;
}

export interface RawUpdatePermission {
  columns: string[] | '*';
  filter: Record<string, unknown>;
  check?: Record<string, unknown>;
  set?: Record<string, string>;
}

export interface RawDeletePermission {
  filter: Record<string, unknown>;
}

// ─── Event triggers ─────────────────────────────────────────────────────────

export interface RawEventTrigger {
  name: string;
  definition: {
    enable_manual?: boolean;
    insert?: { columns: string[] | '*' };
    update?: { columns: string[] | '*' };
    delete?: { columns: string[] | '*' };
  };
  retry_conf: {
    interval_sec?: number;
    num_retries?: number;
    timeout_sec?: number;
  };
  webhook?: string;
  webhook_from_env?: string;
  headers?: RawHeader[];
}

export interface RawHeader {
  name: string;
  value?: string;
  value_from_env?: string;
}

// ─── Actions ────────────────────────────────────────────────────────────────

export interface RawActionsYaml {
  actions?: RawAction[];
  custom_types?: unknown;
}

export interface RawAction {
  name: string;
  definition: {
    kind?: 'synchronous' | 'asynchronous';
    handler?: string;
    handler_from_env?: string;
    forward_client_headers?: boolean;
    headers?: RawHeader[];
    timeout?: number;
    type?: string;
    arguments?: unknown[];
    output_type?: string;
  };
  permissions?: { role: string }[];
  comment?: string;
}

// ─── Cron triggers ──────────────────────────────────────────────────────────

export interface RawCronTrigger {
  name: string;
  webhook?: string;
  webhook_from_env?: string;
  schedule: string;
  payload?: unknown;
  retry_conf?: {
    num_retries?: number;
    retry_interval_seconds?: number;
    timeout_seconds?: number;
    tolerance_seconds?: number;
  };
  headers?: RawHeader[];
  include_in_metadata?: boolean;
  comment?: string;
}

// ─── Hakkyra extension: api_config.yaml ─────────────────────────────────────

export interface RawApiConfig {
  table_aliases?: Record<string, string>;
  custom_queries?: RawCustomQuery[];
  rest?: {
    auto_generate?: boolean;
    base_path?: string;
    pagination?: {
      default_limit?: number;
      max_limit?: number;
    };
    overrides?: Record<string, RawRESTOverride[]>;
  };
  docs?: {
    generate?: boolean;
    output?: string;
    llm_format?: boolean;
    include_examples?: boolean;
  };
}

export interface RawCustomQuery {
  name: string;
  type: 'query' | 'mutation';
  sql: string;
  params?: { name: string; type: string }[];
  returns: string;
  permissions?: {
    role: string;
    filter?: Record<string, unknown>;
  }[];
}

export interface RawRESTOverride {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  operation: string;
  default_order?: string;
}

// ─── Server config (standalone) ─────────────────────────────────────────────

export interface RawServerConfig {
  server?: {
    port?: number;
    host?: string;
  };
  job_queue?: {
    provider?: 'pg-boss' | 'bullmq';
    connection_string?: string;
    redis?: {
      url?: string;
      host?: string;
      port?: number;
      password?: string;
    };
  };
  auth?: {
    jwt?: {
      type?: string;
      key?: string;
      key_from_env?: string;
      jwk_url?: string;
      claims_namespace?: string;
      claims_map?: Record<string, { path: string; default?: string }>;
      audience?: string;
      issuer?: string;
    };
    admin_secret_from_env?: string;
    unauthorized_role?: string;
    webhook?: {
      url?: string;
      url_from_env?: string;
      mode?: 'GET' | 'POST';
      forward_headers?: boolean;
    };
  };
  databases?: {
    primary?: {
      url_from_env?: string;
      pool?: {
        max?: number;
        idle_timeout?: number;
        connection_timeout?: number;
      };
    };
    replicas?: {
      url_from_env?: string;
      pool?: {
        max?: number;
        idle_timeout?: number;
        connection_timeout?: number;
      };
    }[];
    read_your_writes?: {
      enabled?: boolean;
      window_seconds?: number;
    };
  };
}

// ─── Include tag marker ─────────────────────────────────────────────────────

export class IncludeRef {
  constructor(public readonly path: string) {}
}
