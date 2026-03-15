/**
 * Core type definitions shared across all Hakkyra modules.
 *
 * Config-related types are derived from Zod schemas via z.infer<>.
 * Runtime / introspection types remain as manual interfaces.
 */

import { z } from 'zod';
import {
  RelationshipConfigSchema,
  SelectPermissionSchema,
  InsertPermissionSchema,
  UpdatePermissionSchema,
  DeletePermissionSchema,
  TablePermissionsSchema,
  CustomRootFieldsSchema,
  EventTriggerConfigSchema,
  WebhookHeaderSchema,
  CronTriggerConfigSchema,
  RequestTransformSchema,
  ResponseTransformSchema,
  ActionConfigSchema,
  ActionRelationshipSchema,
  RESTEndpointOverrideSchema,
  RESTConfigSchema,
  CustomQueryConfigSchema,
  APIDocsConfigSchema,
  JobQueueProviderSchema,
  JobQueueConfigSchema,
  AuthConfigSchema,
  RedisConfigSchema,
  DatabasesConfigSchema,
  PoolConfigSchema,
  ComputedFieldConfigSchema,
  TrackedFunctionConfigSchema,
  LogicalModelSchema,
  LogicalModelFieldSchema,
  LogicalModelPermissionSchema,
  NativeQuerySchema,
  NativeQueryArgumentSchema,
  QueryCollectionSchema,
  HasuraRestEndpointSchema,
  IntrospectionConfigSchema,
  HakkyraConfigSchema,
} from './config/schemas-internal.js';

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

// ─── Logical Models & Native Queries ─────────────────────────────────────────

export type LogicalModel = z.infer<typeof LogicalModelSchema>;
export type LogicalModelField = z.infer<typeof LogicalModelFieldSchema>;
export type LogicalModelPermission = z.infer<typeof LogicalModelPermissionSchema>;
export type NativeQuery = z.infer<typeof NativeQuerySchema>;
export type NativeQueryArgument = z.infer<typeof NativeQueryArgumentSchema>;

// ─── Internal Schema Model (merged introspection + config) ──────────────────

export interface SchemaModel {
  tables: TableInfo[];
  enums: EnumInfo[];
  functions: FunctionInfo[];
  customQueries: CustomQueryConfig[];
  trackedFunctions: TrackedFunctionConfig[];
  nativeQueries: NativeQuery[];
  logicalModels: LogicalModel[];
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
  isEnum?: boolean;
}

// ─── Computed Fields ─────────────────────────────────────────────────────────

export type ComputedFieldConfig = z.infer<typeof ComputedFieldConfigSchema>;

// ─── Tracked Functions ───────────────────────────────────────────────────────

export type TrackedFunctionConfig = z.infer<typeof TrackedFunctionConfigSchema>;

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
  /** Number of trailing input arguments that have DEFAULT values in PostgreSQL. */
  numArgsWithDefaults: number;
}

// ─── Relationships ──────────────────────────────────────────────────────────

export type RelationshipType = 'object' | 'array';

export type RelationshipConfig = z.infer<typeof RelationshipConfigSchema>;

// ─── Permissions (Hasura-compatible) ────────────────────────────────────────

export type TablePermissions = z.infer<typeof TablePermissionsSchema>;

export type SelectPermission = z.infer<typeof SelectPermissionSchema>;

export type InsertPermission = z.infer<typeof InsertPermissionSchema>;

export type UpdatePermission = z.infer<typeof UpdatePermissionSchema>;

export type DeletePermission = z.infer<typeof DeletePermissionSchema>;

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
  _neq?: unknown;
  _gt?: unknown;
  _lt?: unknown;
  _gte?: unknown;
  _lte?: unknown;
  _in?: unknown[];
  _nin?: unknown[];
  _isNull?: boolean;
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
  _containedIn?: unknown;
  _hasKey?: string;
  _hasKeysAny?: string[];
  _hasKeysAll?: string[];
  // JSONB cast expression
  _cast?: {
    String?: ColumnOperators;
  };
}

// ─── Custom Root Fields ─────────────────────────────────────────────────────

export type CustomRootFields = z.infer<typeof CustomRootFieldsSchema>;

// ─── Event Triggers ─────────────────────────────────────────────────────────

export type EventTriggerConfig = z.infer<typeof EventTriggerConfigSchema>;

export type WebhookHeader = z.infer<typeof WebhookHeaderSchema>;

// ─── Cron Triggers ──────────────────────────────────────────────────────────

export type CronTriggerConfig = z.infer<typeof CronTriggerConfigSchema>;

// ─── Actions ────────────────────────────────────────────────────────────────

export type RequestTransform = z.infer<typeof RequestTransformSchema>;

export type ResponseTransform = z.infer<typeof ResponseTransformSchema>;

export type ActionConfig = z.infer<typeof ActionConfigSchema>;

export type ActionRelationship = z.infer<typeof ActionRelationshipSchema>;

// ─── Async Action Result ─────────────────────────────────────────────────────

export type AsyncActionStatus = 'created' | 'processing' | 'completed' | 'failed';

export interface AsyncActionResult {
  id: string;
  actionName: string;
  status: AsyncActionStatus;
  output?: unknown;
  errors?: unknown;
  createdAt: string;
  updatedAt: string;
}

// ─── Query Collections & Hasura REST Endpoints ──────────────────────────────

export type QueryCollection = z.infer<typeof QueryCollectionSchema>;

export type HasuraRestEndpoint = z.infer<typeof HasuraRestEndpointSchema>;

// ─── REST API Config (Hakkyra extension) ────────────────────────────────────

export type RESTEndpointOverride = z.infer<typeof RESTEndpointOverrideSchema>;

export type RESTConfig = z.infer<typeof RESTConfigSchema>;

// ─── Custom Queries (Hakkyra extension) ─────────────────────────────────────

export type CustomQueryConfig = z.infer<typeof CustomQueryConfigSchema>;

// ─── API Docs Config (Hakkyra extension) ────────────────────────────────────

export type APIDocsConfig = z.infer<typeof APIDocsConfigSchema>;

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
    queryRootFields?: string[];
    subscriptionRootFields?: string[];
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

/**
 * HakkyraConfig derived from the Zod schema, with the `tables` field
 * narrowed to `TableInfo[]` (the schema uses `z.any()` for tables since
 * TableInfo contains introspection data that is not schema-validated).
 */
export type HakkyraConfig = Omit<z.infer<typeof HakkyraConfigSchema>, 'tables'> & {
  tables: TableInfo[];
};

// ─── Job Queue Configuration ─────────────────────────────────────────────────

export type JobQueueProvider = z.infer<typeof JobQueueProviderSchema>;

export type JobQueueConfig = z.infer<typeof JobQueueConfigSchema>;

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export type DatabasesConfig = z.infer<typeof DatabasesConfigSchema>;

export type PoolConfig = z.infer<typeof PoolConfigSchema>;

export type RedisConfig = z.infer<typeof RedisConfigSchema>;

export type IntrospectionConfig = z.infer<typeof IntrospectionConfigSchema>;

// ─── Utility types ──────────────────────────────────────────────────────────

export type Operation = 'select' | 'insert' | 'update' | 'delete';
