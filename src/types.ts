/**
 * Core type definitions shared across all Hakkyra modules.
 */

// ─── PostgreSQL Type Mapping ────────────────────────────────────────────────

export type PgScalarType =
  | 'int2' | 'int4' | 'int8'
  | 'float4' | 'float8' | 'numeric'
  | 'bool'
  | 'text' | 'varchar' | 'char' | 'name'
  | 'uuid'
  | 'json' | 'jsonb'
  | 'date' | 'time' | 'timetz' | 'timestamp' | 'timestamptz' | 'interval'
  | 'bytea'
  | 'inet' | 'cidr' | 'macaddr'
  | 'point' | 'line' | 'lseg' | 'box' | 'path' | 'polygon' | 'circle'
  | 'oid';

// ─── Internal Schema Model (merged introspection + config) ──────────────────

export interface SchemaModel {
  tables: TableInfo[];
  enums: EnumInfo[];
  functions: FunctionInfo[];
  customQueries: CustomQueryConfig[];
}

export interface TableInfo {
  name: string;
  schema: string;
  alias?: string;
  comment?: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  uniqueConstraints: UniqueConstraintInfo[];
  indexes: IndexInfo[];
  relationships: RelationshipConfig[];
  permissions: TablePermissions;
  eventTriggers: EventTriggerConfig[];
  customRootFields?: CustomRootFields;
  computedFields?: ComputedFieldConfig[];
}

// ─── Computed Fields ─────────────────────────────────────────────────────────

export interface ComputedFieldConfig {
  name: string;
  function: {
    name: string;
    schema?: string;  // defaults to 'public'
  };
  tableArgument?: string;  // the function param name for the table row
  sessionArgument?: string; // optional param for session vars (hasura compat)
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;          // raw PG type name
  udtName: string;       // underlying type (e.g., 'int4' for serial)
  isNullable: boolean;
  hasDefault: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  isArray: boolean;
  comment?: string;
  enumValues?: string[]; // if it's an enum type
}

export interface ForeignKeyInfo {
  constraintName: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface UniqueConstraintInfo {
  constraintName: string;
  columns: string[];
}

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
}

export interface EnumInfo {
  name: string;
  schema: string;
  values: string[];
}

export interface FunctionInfo {
  name: string;
  schema: string;
  returnType: string;
  argTypes: string[];
  argNames: string[];
  isSetReturning: boolean;
  volatility: 'immutable' | 'stable' | 'volatile';
}

// ─── Relationships ──────────────────────────────────────────────────────────

export type RelationshipType = 'object' | 'array';

export interface RelationshipConfig {
  name: string;
  type: RelationshipType;
  remoteTable: { name: string; schema: string };
  /** Foreign key on this table (object rel) */
  localColumns?: string[];
  /** Foreign key on the remote table (array rel) */
  remoteColumns?: string[];
  /** Manual mapping when no FK constraint exists */
  columnMapping?: Record<string, string>;
}

// ─── Permissions (Hasura-compatible) ────────────────────────────────────────

export interface TablePermissions {
  select: Record<string, SelectPermission>;
  insert: Record<string, InsertPermission>;
  update: Record<string, UpdatePermission>;
  delete: Record<string, DeletePermission>;
}

export interface SelectPermission {
  columns: string[] | '*';
  filter: BoolExp;
  limit?: number;
  allowAggregations?: boolean;
  computedFields?: string[];
}

export interface InsertPermission {
  columns: string[] | '*';
  check: BoolExp;
  set?: Record<string, string>;       // column presets
  backendOnly?: boolean;
}

export interface UpdatePermission {
  columns: string[] | '*';
  filter: BoolExp;
  check?: BoolExp;                     // post-update validation
  set?: Record<string, string>;
}

export interface DeletePermission {
  filter: BoolExp;
}

// ─── Boolean Expressions (permission filters + query where clauses) ─────────

export type BoolExp =
  | { _and: BoolExp[] }
  | { _or: BoolExp[] }
  | { _not: BoolExp }
  | { _exists: ExistsExp }
  | ColumnBoolExps
  | Record<string, never>;             // empty object = no filter

export interface ExistsExp {
  _table: { name: string; schema: string };
  _where: BoolExp;
}

export type ColumnBoolExps = {
  [column: string]: ColumnOperators | BoolExp;  // BoolExp for relationship traversal
};

export interface ColumnOperators {
  _eq?: unknown;
  _ne?: unknown;
  _gt?: unknown;
  _lt?: unknown;
  _gte?: unknown;
  _lte?: unknown;
  _in?: unknown[];
  _nin?: unknown[];
  _is_null?: boolean;
  _like?: string;
  _nlike?: string;
  _ilike?: string;
  _nilike?: string;
  _similar?: string;
  _nsimilar?: string;
  _regex?: string;
  _nregex?: string;
  _iregex?: string;
  _niregex?: string;
  // JSONB operators
  _contains?: unknown;
  _contained_in?: unknown;
  _has_key?: string;
  _has_keys_any?: string[];
  _has_keys_all?: string[];
}

// ─── Custom Root Fields ─────────────────────────────────────────────────────

export interface CustomRootFields {
  select?: string;
  select_by_pk?: string;
  select_aggregate?: string;
  insert?: string;
  insert_one?: string;
  update?: string;
  update_by_pk?: string;
  delete?: string;
  delete_by_pk?: string;
}

// ─── Event Triggers ─────────────────────────────────────────────────────────

export interface EventTriggerConfig {
  name: string;
  definition: {
    enableManual?: boolean;
    insert?: { columns: string[] | '*' };
    update?: { columns: string[] | '*' };
    delete?: { columns: string[] | '*' };
  };
  retryConf: {
    intervalSec: number;
    numRetries: number;
    timeoutSec: number;
  };
  webhook: string;
  webhookFromEnv?: string;
  headers?: WebhookHeader[];
}

export interface WebhookHeader {
  name: string;
  value?: string;
  valueFromEnv?: string;
}

// ─── Cron Triggers ──────────────────────────────────────────────────────────

export interface CronTriggerConfig {
  name: string;
  webhook: string;
  webhookFromEnv?: string;
  schedule: string;                    // cron expression
  payload?: unknown;
  retryConf?: {
    numRetries: number;
    retryIntervalSeconds: number;
    timeoutSeconds: number;
    toleranceSeconds?: number;
  };
  headers?: WebhookHeader[];
  comment?: string;
}

// ─── Actions ────────────────────────────────────────────────────────────────

export interface ActionConfig {
  name: string;
  definition: {
    kind: 'synchronous' | 'asynchronous';
    type: 'query' | 'mutation';
    handler: string;                   // URL or local file path
    handlerFromEnv?: string;
    forwardClientHeaders?: boolean;
    headers?: WebhookHeader[];
    timeout?: number;
  };
  permissions?: { role: string }[];
  comment?: string;
}

// ─── REST API Config (Hakkyra extension) ────────────────────────────────────

export interface RESTEndpointOverride {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  operation: string;
  defaultOrder?: string;
}

export interface RESTConfig {
  autoGenerate: boolean;
  basePath: string;
  pagination: {
    defaultLimit: number;
    maxLimit: number;
  };
  overrides?: Record<string, RESTEndpointOverride[]>;
}

// ─── Custom Queries (Hakkyra extension) ─────────────────────────────────────

export interface CustomQueryConfig {
  name: string;
  type: 'query' | 'mutation';
  sql: string;
  params?: { name: string; type: string }[];
  returns: string;                     // GraphQL type name
  permissions?: {
    role: string;
    filter?: BoolExp;
  }[];
}

// ─── API Docs Config (Hakkyra extension) ────────────────────────────────────

export interface APIDocsConfig {
  generate: boolean;
  output?: string;
  llmFormat?: boolean;
  includeExamples?: boolean;
}

// ─── Authentication ─────────────────────────────────────────────────────────

export interface SessionVariables {
  role: string;
  userId?: string;
  allowedRoles: string[];
  isAdmin: boolean;
  claims: Record<string, string | string[]>;
}

// ─── ON CONFLICT (Upsert) ────────────────────────────────────────────────────

export interface OnConflictInput {
  constraint: string;           // PK or unique constraint name
  updateColumns: string[];      // columns to update on conflict
  where?: BoolExp;              // optional filter for the update
}

// ─── SQL Compiler Output ────────────────────────────────────────────────────

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

export interface CompiledPermission {
  select?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
    allowAggregations: boolean;
    computedFields?: string[];
  };
  insert?: {
    check: CompiledFilter;
    columns: string[] | '*';
    presets: Record<string, string>;
  };
  update?: {
    filter: CompiledFilter;
    check?: CompiledFilter;
    columns: string[] | '*';
    presets: Record<string, string>;
  };
  delete?: {
    filter: CompiledFilter;
  };
}

export interface CompiledFilter {
  toSQL(session: SessionVariables, paramOffset: number, tableAlias?: string): {
    sql: string;
    params: unknown[];
  };
}

// ─── Server Configuration ───────────────────────────────────────────────────

export interface HakkyraConfig {
  version: number;
  server: {
    port: number;
    host: string;
  };
  auth: AuthConfig;
  databases: DatabasesConfig;
  tables: TableInfo[];
  actions: ActionConfig[];
  actionsGraphql?: string;
  cronTriggers: CronTriggerConfig[];
  rest: RESTConfig;
  customQueries: CustomQueryConfig[];
  apiDocs: APIDocsConfig;
  tableAliases: Record<string, string>;
  /** Job queue backend configuration (default: pg-boss). */
  jobQueue?: JobQueueConfig;
}

// ─── Job Queue Configuration ─────────────────────────────────────────────────

export type JobQueueProvider = 'pg-boss' | 'bullmq';

export interface JobQueueConfig {
  provider: JobQueueProvider;
  /** pg-boss uses the database connection string. Falls back to the primary database URL. */
  connectionString?: string;
  /** Redis connection info, required when provider is 'bullmq'. */
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
  };
}

export interface AuthConfig {
  jwt?: {
    type: string;                      // RS256, HS256, etc.
    key?: string;
    keyEnv?: string;
    jwkUrl?: string;
    claimsNamespace?: string;
    claimsMap?: Record<string, { path: string; default?: string }>;
    audience?: string;
    issuer?: string;
  };
  adminSecretEnv?: string;
  unauthorizedRole?: string;
  webhook?: {
    url: string;
    urlFromEnv?: string;
    mode: 'GET' | 'POST';
    forwardHeaders?: boolean;
  };
}

export interface DatabasesConfig {
  primary: {
    urlEnv: string;
    pool?: PoolConfig;
  };
  replicas?: {
    urlEnv: string;
    pool?: PoolConfig;
  }[];
  readYourWrites?: {
    enabled: boolean;
    windowSeconds: number;
  };
}

export interface PoolConfig {
  max?: number;
  idleTimeout?: number;
  connectionTimeout?: number;
}

// ─── Utility types ──────────────────────────────────────────────────────────

export type Operation = 'select' | 'insert' | 'update' | 'delete';
