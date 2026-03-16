import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import pino from 'pino';
import type {
  HakkyraConfig,
  TableInfo,
  RelationshipConfig,
  TablePermissions,
  EventTriggerConfig,
  WebhookHeader,
  ActionConfig,
  ActionRelationship,
  RequestTransform,
  ResponseTransform,
  CronTriggerConfig,
  CustomRootFields,
  RESTConfig,
  CustomQueryConfig,
  APIDocsConfig,
  AuthConfig,
  DatabasesConfig,
  JobQueueConfig,
  RedisConfig,
  BoolExp,
  ComputedFieldConfig,
  TrackedFunctionConfig,
  NativeQuery,
  LogicalModel,
  QueryCollection,
  HasuraRestEndpoint,
} from '../types.js';
import type {
  RawTableYaml,
  RawRelationship,
  RawComputedField,
  RawEventTrigger,
  RawHeader,
  RawAction,
  RawCronTrigger,
  RawApiConfig,
  RawServerConfig,
  RawDatabaseEntry,
  RawTrackedFunction,
  RawNativeQuery,
  RawLogicalModel,
} from './types.js';
import { IncludeRef } from './types.js';
import {
  RawVersionYamlSchema,
  RawDatabaseEntrySchema,
  RawDatabasesYamlSchema,
  RawTableYamlSchema,
  RawTrackedFunctionSchema,
  RawActionSchema,
  RawActionsYamlSchema,
  RawCronTriggerSchema,
  RawApiConfigSchema,
  RawServerConfigSchema,
  RawIntrospectionConfigSchema,
  RawQueryCollectionSchema,
  RawHasuraRestEndpointSchema,
} from './schemas.js';
import {
  HakkyraConfigSchema,
  PoolConfigSchema as InternalPoolConfigSchema,
  DatabasesConfigSchema as InternalDatabasesConfigSchema,
  RESTConfigSchema as InternalRESTConfigSchema,
  AuthConfigSchema as InternalAuthConfigSchema,
  JobQueueConfigSchema as InternalJobQueueConfigSchema,
} from './schemas-internal.js';

const log = pino({ name: 'hakkyra:config' });

// ─── YAML Schema with !include support ─────────────────────────────────────

const IncludeYamlType = new yaml.Type('!include', {
  kind: 'scalar',
  resolve(data: string) {
    return typeof data === 'string' && data.length > 0;
  },
  construct(data: string) {
    return new IncludeRef(data);
  },
});

const HAKKYRA_SCHEMA = yaml.DEFAULT_SCHEMA.extend([IncludeYamlType]);

// ─── File helpers ───────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function loadYaml(content: string, filename?: string): unknown {
  return yaml.load(content, { schema: HAKKYRA_SCHEMA, filename });
}

async function readYaml(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf-8');
  return loadYaml(content, filePath);
}

async function readYamlIfExists(filePath: string): Promise<unknown | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  return readYaml(filePath);
}

async function resolveIncludes(data: unknown, baseDir: string): Promise<unknown> {
  if (data instanceof IncludeRef) {
    const includePath = path.resolve(baseDir, data.path);
    const included = await readYaml(includePath);
    return resolveIncludes(included, path.dirname(includePath));
  }
  // Handle quoted "!include filename.yaml" strings (Hasura CLI generates these)
  if (typeof data === 'string' && data.startsWith('!include ')) {
    const includePath = path.resolve(baseDir, data.slice('!include '.length).trim());
    const included = await readYaml(includePath);
    return resolveIncludes(included, path.dirname(includePath));
  }
  if (Array.isArray(data)) {
    return Promise.all(data.map((item) => resolveIncludes(item, baseDir)));
  }
  if (data !== null && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      result[key] = await resolveIncludes(value, baseDir);
    }
    return result;
  }
  return data;
}

// ─── Environment variable resolution ────────────────────────────────────────

function resolveEnv(envVar: string | undefined): string | undefined {
  if (!envVar) return undefined;
  const value = process.env[envVar];
  if (value === undefined) {
    log.warn({ envVar }, 'Environment variable not set');
  }
  return value;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip keys whose value is `undefined` so that Zod `.default()` can kick in.
 * Returns `undefined` when every field is undefined (i.e. an empty object after
 * stripping), so Zod outer `.default({})` will trigger for the whole section.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> | undefined {
  const result: Record<string, unknown> = {};
  let hasValue = false;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      result[k] = v;
      hasValue = true;
    }
  }
  return hasValue ? (result as Partial<T>) : undefined;
}

/** Remove known keys from a raw object so that .strict() Zod parsing doesn't reject them. */
function omitKeys<T extends Record<string, unknown>>(obj: T, keys: string[]): T {
  const result = { ...obj };
  for (const key of keys) {
    delete (result as Record<string, unknown>)[key];
  }
  return result;
}

// ─── Unsupported Hasura feature detection ───────────────────────────────────

const UNSUPPORTED_METADATA_FILES: Record<string, string> = {
  remote_schemas: 'Remote schemas',
  allowlist: 'Query allowlisting',
  api_limits: 'API rate/depth limits',
  opentelemetry: 'OpenTelemetry export',
  network: 'Network/TLS configuration',
  backend_configs: 'Backend-specific configuration',
};

const UNSUPPORTED_TABLE_FIELDS: Record<string, string> = {
  remote_relationships: 'Remote relationships are not supported by Hakkyra by design',
  apollo_federation_config: 'Apollo Federation is not supported by Hakkyra by design',
};

const UNSUPPORTED_DATABASE_FIELDS: Record<string, string> = {
  stored_procedures: 'Stored procedures',
  backend_configs: 'Backend-specific configuration',
  customization: 'Database customization (table name prefix/suffix, root field namespace)',
};

const UNSUPPORTED_PERMISSION_FIELDS: Record<string, string> = {};

const IGNORED_PERMISSION_FIELDS: Record<string, string> = {
  validate_input: 'Input validation webhook (validate_input) is not supported by Hakkyra and will be ignored',
};

function hasContent(raw: unknown): boolean {
  if (raw == null) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === 'object') return Object.keys(raw).length > 0;
  return true;
}

async function checkUnsupportedFiles(metadataDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const [baseName, label] of Object.entries(UNSUPPORTED_METADATA_FILES)) {
    for (const ext of ['.yaml', '.yml']) {
      const filePath = path.join(metadataDir, baseName + ext);
      if (!(await fileExists(filePath))) continue;
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim().length === 0) break;
      const parsed = loadYaml(content, filePath);
      if (hasContent(parsed)) {
        found.push(`${baseName}${ext} (${label})`);
      }
      break; // don't report both .yaml and .yml for the same feature
    }
  }
  return found;
}

function checkUnsupportedTableFields(
  raw: Record<string, unknown>,
  tableName: string,
): string[] {
  const found: string[] = [];
  for (const [field, label] of Object.entries(UNSUPPORTED_TABLE_FIELDS)) {
    if (raw[field] !== undefined) {
      found.push(`table "${tableName}": ${field} — ${label}`);
    }
  }
  // Check permission entries for unsupported fields
  for (const permType of ['select_permissions', 'insert_permissions', 'update_permissions', 'delete_permissions'] as const) {
    const perms = raw[permType];
    if (!Array.isArray(perms)) continue;
    for (const entry of perms) {
      if (!entry || typeof entry !== 'object') continue;
      const perm = (entry as Record<string, unknown>).permission;
      const role = (entry as Record<string, unknown>).role as string;
      if (!perm || typeof perm !== 'object') continue;
      for (const [field, label] of Object.entries(UNSUPPORTED_PERMISSION_FIELDS)) {
        if ((perm as Record<string, unknown>)[field] !== undefined) {
          found.push(`table "${tableName}" ${permType.replace('_permissions', '')} permission for role "${role}": ${field} — ${label}`);
        }
      }
      for (const [field, message] of Object.entries(IGNORED_PERMISSION_FIELDS)) {
        if ((perm as Record<string, unknown>)[field] !== undefined) {
          log.warn({ table: tableName, role, permType }, message);
        }
      }
    }
  }
  return found;
}

function checkUnsupportedDatabaseFields(
  raw: Record<string, unknown>,
  dbName: string,
): string[] {
  const found: string[] = [];
  for (const [field, label] of Object.entries(UNSUPPORTED_DATABASE_FIELDS)) {
    if (raw[field] !== undefined) {
      found.push(`database "${dbName}": ${field} — ${label}`);
    }
  }
  return found;
}

// ─── Main loader ────────────────────────────────────────────────────────────

/**
 * Load Hasura v2/v3 metadata and Hakkyra extensions into a unified config.
 *
 * @param metadataDir - Path to the Hasura metadata directory
 * @param serverConfigPath - Optional path to server config YAML file
 */
export async function loadConfig(
  metadataDir: string,
  serverConfigPath?: string,
): Promise<HakkyraConfig> {
  const absMetadataDir = path.resolve(metadataDir);

  const unsupported = await checkUnsupportedFiles(absMetadataDir);

  const version = await loadVersion(absMetadataDir);
  const { databases, nativeQueries, logicalModels, unsupported: dbUnsupported } = await loadDatabases(absMetadataDir);
  const { tables, unsupported: tableUnsupported } = await loadAllTables(absMetadataDir);
  unsupported.push(...dbUnsupported, ...tableUnsupported);

  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Hasura features found:\n  - ${unsupported.join('\n  - ')}\n\nThese features are not supported by Hakkyra. Remove them from your metadata to continue.`,
    );
  }

  const trackedFunctions = await loadAllFunctions(absMetadataDir);
  const actions = await loadActions(absMetadataDir);
  const actionsGraphql = await loadActionsGraphql(absMetadataDir);
  const cronTriggers = await loadCronTriggers(absMetadataDir);
  const apiConfig = await loadApiConfig(absMetadataDir);
  const serverConfig = await loadServerConfig(serverConfigPath);
  const inheritedRoles = await loadInheritedRoles(absMetadataDir);
  const introspectionConfig = await loadIntrospectionConfig(absMetadataDir);
  const queryCollections = await loadQueryCollections(absMetadataDir);
  const hasuraRestEndpoints = await loadRestEndpoints(absMetadataDir, queryCollections);

  const tableAliases = apiConfig?.table_aliases ?? {};
  for (const table of tables) {
    const qualifiedName = `${table.schema}.${table.name}`;
    if (tableAliases[qualifiedName]) {
      table.alias = tableAliases[qualifiedName];
    } else if (tableAliases[table.name]) {
      table.alias = tableAliases[table.name];
    }
  }

  const raw = {
    version,
    server: stripUndefined({
      port: serverConfig?.server?.port,
      host: serverConfig?.server?.host,
      logLevel: serverConfig?.server?.log_level,
      stringifyNumericTypes: serverConfig?.server?.stringify_numeric_types,
      bodyLimit: serverConfig?.server?.body_limit,
      schemaName: serverConfig?.server?.schema_name,
    }) ?? {},
    auth: transformAuth(serverConfig),
    databases: transformDatabases(databases, serverConfig),
    tables,
    trackedFunctions,
    actions,
    actionsGraphql: actionsGraphql ?? undefined,
    cronTriggers,
    rest: transformRESTConfig(apiConfig),
    customQueries: transformCustomQueries(apiConfig),
    queryCollections,
    hasuraRestEndpoints,
    nativeQueries,
    logicalModels,
    apiDocs: transformDocsConfig(apiConfig),
    tableAliases,
    inheritedRoles,
    jobQueue: transformJobQueueConfig(serverConfig),
    redis: transformRedisConfig(serverConfig),
    eventLogRetentionDays: serverConfig?.event_log?.retention_days,
    slowQueryThresholdMs: serverConfig?.server?.slow_query_threshold_ms,
    queryCache: stripUndefined({
      maxSize: serverConfig?.query_cache?.max_size,
    }),
    subscriptions: stripUndefined({
      debounceMs: serverConfig?.subscriptions?.debounce_ms,
      keepAliveMs: serverConfig?.subscriptions?.keep_alive_ms,
    }),
    eventDelivery: stripUndefined({
      batchSize: serverConfig?.event_delivery?.batch_size,
      httpConcurrency: serverConfig?.event_delivery?.http_concurrency,
    }),
    eventCleanup: stripUndefined({
      schedule: serverConfig?.event_cleanup?.schedule,
    }),
    webhook: stripUndefined({
      timeoutMs: serverConfig?.webhook?.timeout_ms,
      backoffCapSeconds: serverConfig?.webhook?.backoff_cap_seconds,
      allowPrivateUrls: serverConfig?.webhook?.allow_private_urls,
      maxResponseBytes: serverConfig?.webhook?.max_response_bytes,
    }),
    actionDefaults: stripUndefined({
      timeoutSeconds: serverConfig?.action_defaults?.timeout_seconds,
      asyncRetryLimit: serverConfig?.action_defaults?.async_retry_limit,
      asyncRetryDelaySeconds: serverConfig?.action_defaults?.async_retry_delay_seconds,
      asyncTimeoutSeconds: serverConfig?.action_defaults?.async_timeout_seconds,
    }),
    graphql: stripUndefined({
      queryDepth: serverConfig?.graphql?.query_depth,
      maxLimit: serverConfig?.graphql?.max_limit,
      maxBatchSize: serverConfig?.graphql?.max_batch_size,
    }),
    sql: stripUndefined({
      arrayAnyThreshold: serverConfig?.sql?.array_any_threshold,
      unnestThreshold: serverConfig?.sql?.unnest_threshold,
      batchChunkSize: serverConfig?.sql?.batch_chunk_size,
    }),
    introspection: introspectionConfig,
  };

  return HakkyraConfigSchema.parse(raw);
}

// ─── Version ────────────────────────────────────────────────────────────────

async function loadVersion(metadataDir: string): Promise<number> {
  const raw = await readYamlIfExists(path.join(metadataDir, 'version.yaml'));
  if (raw && typeof raw === 'object' && 'version' in raw) {
    const parsed = RawVersionYamlSchema.parse(raw);
    return parsed.version;
  }
  log.warn('version.yaml not found or invalid, defaulting to version 3');
  return 3;
}

// ─── Databases ──────────────────────────────────────────────────────────────

async function loadDatabases(
  metadataDir: string,
): Promise<{ databases: RawDatabaseEntry[]; nativeQueries: NativeQuery[]; logicalModels: LogicalModel[]; unsupported: string[] }> {
  const dbPath = path.join(metadataDir, 'databases', 'databases.yaml');
  const raw = await readYamlIfExists(dbPath);
  if (!raw) return { databases: [], nativeQueries: [], logicalModels: [], unsupported: [] };

  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === 'object' && raw !== null && 'databases' in raw) {
    const parsed = RawDatabasesYamlSchema.parse(raw);
    entries = parsed.databases ?? [];
  } else {
    return { databases: [], nativeQueries: [], logicalModels: [], unsupported: [] };
  }

  const unsupported: string[] = [];
  const databases: RawDatabaseEntry[] = [];
  const nativeQueries: NativeQuery[] = [];
  const logicalModels: LogicalModel[] = [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      const rawEntry = entry as Record<string, unknown>;
      unsupported.push(...checkUnsupportedDatabaseFields(rawEntry, (rawEntry.name as string) ?? 'unknown'));
    }
    // Strip known-unsupported fields before strict Zod parsing
    const cleanedEntry = entry && typeof entry === 'object'
      ? omitKeys(entry as Record<string, unknown>, Object.keys(UNSUPPORTED_DATABASE_FIELDS))
      : entry;
    const dbEntry = RawDatabaseEntrySchema.parse(cleanedEntry);
    databases.push(dbEntry);

    // Extract native queries and logical models from the database entry
    if (dbEntry.native_queries) {
      for (const rawNq of dbEntry.native_queries) {
        nativeQueries.push(transformNativeQuery(rawNq));
      }
    }
    if (dbEntry.logical_models) {
      for (const rawLm of dbEntry.logical_models) {
        logicalModels.push(transformLogicalModel(rawLm));
      }
    }
  }
  return { databases, nativeQueries, logicalModels, unsupported };
}

function transformNativeQuery(raw: RawNativeQuery): NativeQuery {
  const args: NativeQuery['arguments'] = [];
  if (raw.arguments) {
    for (const [name, argDef] of Object.entries(raw.arguments)) {
      args.push({
        name,
        type: argDef.type,
        nullable: argDef.nullable ?? false,
      });
    }
  }
  return {
    rootFieldName: raw.root_field_name,
    code: raw.code,
    arguments: args,
    returns: raw.returns,
  };
}

function transformLogicalModel(raw: RawLogicalModel): LogicalModel {
  return {
    name: raw.name,
    fields: raw.fields.map((f) => ({
      name: f.name,
      type: f.type.scalar,
      nullable: f.type.nullable ?? true,
    })),
    selectPermissions: (raw.select_permissions ?? []).map((p) => ({
      role: p.role,
      columns: p.permission.columns,
      filter: p.permission.filter as BoolExp,
    })),
  };
}

function transformDatabases(
  rawDbs: RawDatabaseEntry[],
  serverConfig: RawServerConfig | null,
): DatabasesConfig {
  const primaryDb = rawDbs.find((db) => db.name === 'default') ?? rawDbs[0];

  let primaryUrlEnv = 'DATABASE_URL';
  if (primaryDb?.configuration?.connection_info?.database_url) {
    const dbUrl = primaryDb.configuration.connection_info.database_url;
    if (typeof dbUrl === 'object' && 'from_env' in dbUrl) {
      primaryUrlEnv = dbUrl.from_env;
    }
  }
  if (serverConfig?.databases?.primary?.url_from_env) {
    primaryUrlEnv = serverConfig.databases.primary.url_from_env;
  }

  const pool = primaryDb?.configuration?.connection_info?.pool_settings;
  const serverPool = serverConfig?.databases?.primary?.pool;

  const replicas: DatabasesConfig['replicas'] = [];
  if (primaryDb?.configuration?.read_replicas) {
    for (const replica of primaryDb.configuration.read_replicas) {
      const replicaUrl = replica.database_url;
      const replicaUrlEnv =
        typeof replicaUrl === 'object' && replicaUrl && 'from_env' in replicaUrl
          ? replicaUrl.from_env
          : 'DATABASE_REPLICA_URL';
      replicas.push({
        urlEnv: replicaUrlEnv,
        pool: replica.pool_settings
          ? InternalPoolConfigSchema.parse(stripUndefined({
              max: replica.pool_settings.max_connections,
              idleTimeout: replica.pool_settings.idle_timeout,
              maxLifetime: replica.pool_settings.connection_lifetime,
            }))
          : undefined,
      });
    }
  }
  if (serverConfig?.databases?.replicas) {
    for (const r of serverConfig.databases.replicas) {
      replicas.push({
        urlEnv: r.url_from_env ?? 'DATABASE_REPLICA_URL',
        pool: r.pool
          ? InternalPoolConfigSchema.parse(stripUndefined({
              max: r.pool.max,
              idleTimeout: r.pool.idle_timeout,
              connectionTimeout: r.pool.connection_timeout,
              maxLifetime: r.pool.max_lifetime,
              allowExitOnIdle: r.pool.allow_exit_on_idle,
            }))
          : undefined,
      });
    }
  }

  const ryw = serverConfig?.databases?.read_your_writes;
  const ps = serverConfig?.databases?.prepared_statements;
  const sessionConfig = serverConfig?.databases?.session;
  const subRouting = serverConfig?.databases?.subscription_query_routing;

  return InternalDatabasesConfigSchema.parse({
    primary: {
      urlEnv: primaryUrlEnv,
      pool: stripUndefined({
        max: serverPool?.max ?? pool?.max_connections,
        idleTimeout: serverPool?.idle_timeout ?? pool?.idle_timeout,
        connectionTimeout: serverPool?.connection_timeout,
        maxLifetime: serverPool?.max_lifetime ?? pool?.connection_lifetime,
        allowExitOnIdle: serverPool?.allow_exit_on_idle,
      }),
    },
    replicas: replicas.length > 0 ? replicas : undefined,
    session: sessionConfig?.url_from_env
      ? { urlEnv: sessionConfig.url_from_env }
      : undefined,
    readYourWrites: ryw
      ? stripUndefined({ enabled: ryw.enabled, windowSeconds: ryw.window_seconds })
      : undefined,
    preparedStatements: ps
      ? { enabled: ps.enabled ?? false, maxCached: ps.max_cached }
      : undefined,
    subscriptionQueryRouting: subRouting,
  });
}

// ─── Tables ─────────────────────────────────────────────────────────────────

async function loadAllTables(
  metadataDir: string,
): Promise<{ tables: TableInfo[]; unsupported: string[] }> {
  const tables: TableInfo[] = [];
  const unsupported: string[] = [];

  const databasesDir = path.join(metadataDir, 'databases');
  if (!(await fileExists(databasesDir))) return { tables, unsupported };

  let entries: string[];
  try {
    entries = await fs.readdir(databasesDir);
  } catch {
    return { tables, unsupported };
  }

  for (const dbName of entries) {
    const dbDir = path.join(databasesDir, dbName);
    const stat = await fs.stat(dbDir);
    if (!stat.isDirectory()) continue;

    const tablesDir = path.join(dbDir, 'tables');
    if (!(await fileExists(tablesDir))) continue;

    const tablesYamlPath = path.join(tablesDir, 'tables.yaml');
    const rawTablesIndex = await readYamlIfExists(tablesYamlPath);
    if (!rawTablesIndex) continue;

    const resolved = await resolveIncludes(rawTablesIndex, tablesDir);
    const rawTables = Array.isArray(resolved) ? resolved : [resolved];

    for (const rawTable of rawTables) {
      if (!rawTable || typeof rawTable !== 'object') continue;
      const rawObj = rawTable as Record<string, unknown>;
      const tableId = rawObj.table as { schema?: string; name?: string } | undefined;
      const tableName = tableId ? `${tableId.schema ?? 'public'}.${tableId.name ?? 'unknown'}` : 'unknown';
      unsupported.push(...checkUnsupportedTableFields(rawObj, tableName));
      // Strip known-unsupported table fields before strict Zod parsing
      const cleanedTable = omitKeys(rawObj, Object.keys(UNSUPPORTED_TABLE_FIELDS));
      // Strip ignored permission fields (e.g. validate_input) from all permission types
      for (const permType of ['select_permissions', 'insert_permissions', 'update_permissions', 'delete_permissions'] as const) {
        const perms = (cleanedTable as Record<string, unknown>)[permType];
        if (Array.isArray(perms)) {
          (cleanedTable as Record<string, unknown>)[permType] = perms.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object') return entry;
            const e = entry as Record<string, unknown>;
            if (!e.permission || typeof e.permission !== 'object') return entry;
            return { ...e, permission: omitKeys(e.permission as Record<string, unknown>, Object.keys(IGNORED_PERMISSION_FIELDS)) };
          });
        }
      }
      const tableConfig = RawTableYamlSchema.parse(cleanedTable);
      if (!tableConfig.table) continue;
      tables.push(transformTable(tableConfig));
    }
  }

  return { tables, unsupported };
}

function transformTable(raw: RawTableYaml): TableInfo {
  const relationships: RelationshipConfig[] = [];

  if (raw.object_relationships) {
    for (const rel of raw.object_relationships) {
      relationships.push(transformRelationship(rel, 'object'));
    }
  }
  if (raw.array_relationships) {
    for (const rel of raw.array_relationships) {
      relationships.push(transformRelationship(rel, 'array'));
    }
  }

  const permissions = transformPermissions(raw);
  const eventTriggers = (raw.event_triggers ?? []).map(transformEventTrigger);
  const computedFields = (raw.computed_fields ?? []).map(transformComputedField);

  let customRootFields: CustomRootFields | undefined;
  if (raw.configuration?.custom_root_fields) {
    customRootFields = raw.configuration.custom_root_fields as CustomRootFields;
  }

  return {
    name: raw.table.name,
    schema: raw.table.schema,
    comment: raw.configuration?.comment,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
    relationships,
    permissions,
    eventTriggers,
    customRootFields,
    computedFields: computedFields.length > 0 ? computedFields : undefined,
    isEnum: raw.is_enum || undefined,
  };
}

// ─── Tracked Functions ───────────────────────────────────────────────────────

async function loadAllFunctions(metadataDir: string): Promise<TrackedFunctionConfig[]> {
  const trackedFunctions: TrackedFunctionConfig[] = [];

  const databasesDir = path.join(metadataDir, 'databases');
  if (!(await fileExists(databasesDir))) return trackedFunctions;

  let entries: string[];
  try {
    entries = await fs.readdir(databasesDir);
  } catch {
    return trackedFunctions;
  }

  for (const dbName of entries) {
    const dbDir = path.join(databasesDir, dbName);
    const stat = await fs.stat(dbDir);
    if (!stat.isDirectory()) continue;

    const functionsDir = path.join(dbDir, 'functions');
    if (!(await fileExists(functionsDir))) continue;

    const functionsYamlPath = path.join(functionsDir, 'functions.yaml');
    const rawFunctionsIndex = await readYamlIfExists(functionsYamlPath);
    if (!rawFunctionsIndex) continue;

    const resolved = await resolveIncludes(rawFunctionsIndex, functionsDir);
    const rawFunctions = Array.isArray(resolved) ? resolved : [resolved];

    for (const rawFunction of rawFunctions) {
      if (!rawFunction || typeof rawFunction !== 'object') continue;
      const functionConfig = RawTrackedFunctionSchema.parse(rawFunction);
      if (!functionConfig.function) continue;
      trackedFunctions.push(transformTrackedFunction(functionConfig));
    }
  }

  return trackedFunctions;
}

function transformTrackedFunction(raw: RawTrackedFunction): TrackedFunctionConfig {
  return {
    name: raw.function.name,
    schema: raw.function.schema ?? 'public',
    exposedAs: raw.configuration?.exposed_as,
    customRootFields: raw.configuration?.custom_root_fields
      ? {
          function: raw.configuration.custom_root_fields.function,
          functionAggregate: raw.configuration.custom_root_fields.function_aggregate,
        }
      : undefined,
    sessionArgument: raw.configuration?.session_argument,
    permissions: raw.permissions,
  };
}

function transformComputedField(raw: RawComputedField): ComputedFieldConfig {
  return {
    name: raw.name,
    function: {
      name: raw.definition.function.name,
      schema: raw.definition.function.schema ?? 'public',
    },
    tableArgument: raw.definition.table_argument,
    sessionArgument: raw.definition.session_argument,
    comment: raw.comment,
  };
}

function transformRelationship(
  raw: RawRelationship,
  type: 'object' | 'array',
): RelationshipConfig {
  const rel: RelationshipConfig = {
    name: raw.name,
    type,
    remoteTable: { name: '', schema: 'public' },
  };

  const fk = raw.using.foreign_key_constraint_on;
  if (fk) {
    if (typeof fk === 'string') {
      rel.localColumns = [fk];
    } else if (Array.isArray(fk)) {
      // Composite FK as array of column names
      rel.localColumns = fk;
    } else {
      // Object form: { column?, columns?, table? }
      if (fk.table) {
        if (typeof fk.table === 'string') {
          rel.remoteTable = { name: fk.table, schema: 'public' };
        } else {
          rel.remoteTable = { name: fk.table.name, schema: fk.table.schema };
        }
      }
      const cols = fk.columns ?? (fk.column ? [fk.column] : undefined);
      if (cols) {
        // For array rels, these are remote columns; for object rels, local columns
        if (type === 'array') {
          rel.remoteColumns = cols;
        } else {
          rel.localColumns = cols;
        }
      }
    }
  }

  const manual = raw.using.manual_configuration;
  if (manual) {
    rel.remoteTable = { name: manual.remote_table.name, schema: manual.remote_table.schema };
    rel.columnMapping = manual.column_mapping;
  }

  return rel;
}

// ─── Permissions ────────────────────────────────────────────────────────────

function transformPermissions(raw: RawTableYaml): TablePermissions {
  const perms: TablePermissions = {
    select: {},
    insert: {},
    update: {},
    delete: {},
  };

  if (raw.select_permissions) {
    for (const entry of raw.select_permissions) {
      const perm = entry.permission as Record<string, unknown>;
      perms.select[entry.role] = {
        columns: entry.permission.columns,
        filter: entry.permission.filter as BoolExp,
        limit: entry.permission.limit,
        allowAggregations: entry.permission.allow_aggregations,
        computedFields: entry.permission.computed_fields,
        queryRootFields: perm.query_root_fields as string[] | undefined,
        subscriptionRootFields: perm.subscription_root_fields as string[] | undefined,
      };
    }
  }

  if (raw.insert_permissions) {
    for (const entry of raw.insert_permissions) {
      perms.insert[entry.role] = {
        columns: entry.permission.columns,
        check: entry.permission.check as BoolExp,
        set: entry.permission.set,
        backendOnly: entry.backend_only ?? entry.permission.backend_only,
      };
    }
  }

  if (raw.update_permissions) {
    for (const entry of raw.update_permissions) {
      perms.update[entry.role] = {
        columns: entry.permission.columns,
        filter: entry.permission.filter as BoolExp,
        check: (entry.permission.check ?? undefined) as BoolExp | undefined,
        set: entry.permission.set,
      };
    }
  }

  if (raw.delete_permissions) {
    for (const entry of raw.delete_permissions) {
      perms.delete[entry.role] = {
        filter: entry.permission.filter as BoolExp,
      };
    }
  }

  return perms;
}

// ─── Event triggers ─────────────────────────────────────────────────────────

function transformEventTrigger(raw: RawEventTrigger): EventTriggerConfig {
  const webhook = raw.webhook ?? resolveEnv(raw.webhook_from_env) ?? '';

  return {
    name: raw.name,
    definition: {
      enableManual: raw.definition.enable_manual,
      insert: raw.definition.insert,
      update: raw.definition.update,
      delete: raw.definition.delete,
    },
    retryConf: {
      intervalSec: raw.retry_conf.interval_sec ?? 10,
      numRetries: raw.retry_conf.num_retries ?? 0,
      timeoutSec: raw.retry_conf.timeout_sec ?? 60,
    },
    webhook,
    webhookFromEnv: raw.webhook_from_env,
    headers: raw.headers?.map(transformHeader),
    concurrency: raw.concurrency,
  };
}

function transformHeader(raw: RawHeader): WebhookHeader {
  return {
    name: raw.name,
    value: raw.value,
    valueFromEnv: raw.value_from_env,
  };
}

// ─── Inherited Roles ─────────────────────────────────────────────────────────

async function loadInheritedRoles(
  metadataDir: string,
): Promise<Record<string, string[]>> {
  const filePath = path.join(metadataDir, 'inherited_roles.yaml');
  const raw = await readYamlIfExists(filePath);
  if (!raw || !Array.isArray(raw)) return {};

  const result: Record<string, string[]> = {};
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && 'role_name' in entry && 'role_set' in entry) {
      const roleName = entry.role_name as string;
      const roleSet = entry.role_set as string[];
      if (typeof roleName === 'string' && Array.isArray(roleSet)) {
        result[roleName] = roleSet;
      }
    }
  }
  return result;
}

// ─── Introspection Config ────────────────────────────────────────────────────

async function loadIntrospectionConfig(
  metadataDir: string,
): Promise<{ disabledForRoles: string[] }> {
  const raw = await readYamlIfExists(path.join(metadataDir, 'graphql_schema_introspection.yaml'));
  if (!raw || typeof raw !== 'object') return { disabledForRoles: [] };
  const parsed = RawIntrospectionConfigSchema.parse(raw);
  return { disabledForRoles: parsed.disabled_for_roles ?? [] };
}

// ─── Query Collections & Hasura REST Endpoints ──────────────────────────────

async function loadQueryCollections(metadataDir: string): Promise<QueryCollection[]> {
  const filePath = path.join(metadataDir, 'query_collections.yaml');
  const raw = await readYamlIfExists(filePath);
  if (!raw || !Array.isArray(raw)) return [];

  const collections: QueryCollection[] = [];
  for (const entry of raw) {
    const parsed = RawQueryCollectionSchema.parse(entry);
    const queries = new Map<string, string>();
    for (const q of parsed.definition.queries) {
      queries.set(q.name, q.query);
    }
    collections.push({ name: parsed.name, queries });
  }
  return collections;
}

async function loadRestEndpoints(
  metadataDir: string,
  queryCollections: QueryCollection[],
): Promise<HasuraRestEndpoint[]> {
  const filePath = path.join(metadataDir, 'rest_endpoints.yaml');
  const raw = await readYamlIfExists(filePath);
  if (!raw || !Array.isArray(raw)) return [];

  // Build a lookup for validation
  const collectionMap = new Map<string, QueryCollection>();
  for (const col of queryCollections) {
    collectionMap.set(col.name, col);
  }

  const endpoints: HasuraRestEndpoint[] = [];
  for (const entry of raw) {
    const parsed = RawHasuraRestEndpointSchema.parse(entry);
    const collectionName = parsed.definition.query.collection_name;
    const queryName = parsed.definition.query.query_name;

    // Validate: collection must exist
    const collection = collectionMap.get(collectionName);
    if (!collection) {
      throw new Error(
        `REST endpoint "${parsed.name}" references non-existent query collection "${collectionName}"`,
      );
    }

    // Validate: query must exist in the collection
    if (!collection.queries.has(queryName)) {
      throw new Error(
        `REST endpoint "${parsed.name}" references non-existent query "${queryName}" in collection "${collectionName}"`,
      );
    }

    endpoints.push({
      name: parsed.name,
      url: parsed.url,
      methods: parsed.methods,
      collectionName,
      queryName,
      comment: parsed.comment,
    });
  }

  return endpoints;
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function loadActions(metadataDir: string): Promise<ActionConfig[]> {
  const actionsPath = path.join(metadataDir, 'actions.yaml');
  const raw = await readYamlIfExists(actionsPath);
  if (!raw) return [];

  let rawActions: RawAction[] = [];
  if (Array.isArray(raw)) {
    rawActions = raw.map((entry) => RawActionSchema.parse(entry));
  } else if (typeof raw === 'object' && raw !== null && 'actions' in raw) {
    const parsed = RawActionsYamlSchema.parse(raw);
    rawActions = parsed.actions ?? [];
  }

  return rawActions.map(transformAction);
}

function transformAction(raw: RawAction): ActionConfig {
  const handler = raw.definition.handler ?? resolveEnv(raw.definition.handler_from_env) ?? '';

  let requestTransform: RequestTransform | undefined;
  if (raw.definition.request_transform) {
    const rt = raw.definition.request_transform;
    requestTransform = {
      method: rt.method,
      url: rt.url,
      body: rt.body,
      contentType: rt.content_type,
      queryParams: rt.query_params,
      headers: rt.headers,
    };
  }

  let responseTransform: ResponseTransform | undefined;
  if (raw.definition.response_transform) {
    responseTransform = {
      body: raw.definition.response_transform.body,
    };
  }

  let relationships: ActionRelationship[] | undefined;
  if (raw.relationships && raw.relationships.length > 0) {
    relationships = raw.relationships.map((rel) => {
      let remoteTable: { schema: string; name: string };
      if (typeof rel.remote_table === 'string') {
        remoteTable = { schema: 'public', name: rel.remote_table };
      } else {
        remoteTable = { schema: rel.remote_table.schema, name: rel.remote_table.name };
      }
      return {
        name: rel.name,
        type: rel.type,
        remoteTable,
        fieldMapping: rel.field_mapping,
      };
    });
  }

  return {
    name: raw.name,
    definition: {
      kind: (raw.definition.kind || undefined) as 'synchronous' | 'asynchronous',
      type: (raw.definition.type || undefined) as 'query' | 'mutation',
      handler,
      handlerFromEnv: raw.definition.handler_from_env,
      forwardClientHeaders: raw.definition.forward_client_headers,
      headers: raw.definition.headers?.map(transformHeader),
      timeout: raw.definition.timeout,
    },
    requestTransform,
    responseTransform,
    permissions: raw.permissions,
    relationships,
    comment: raw.comment,
  };
}

// ─── Actions GraphQL SDL ─────────────────────────────────────────────────────

async function loadActionsGraphql(metadataDir: string): Promise<string | null> {
  const graphqlPath = path.join(metadataDir, 'actions.graphql');
  if (!(await fileExists(graphqlPath))) return null;
  return fs.readFile(graphqlPath, 'utf-8');
}

// ─── Cron triggers ──────────────────────────────────────────────────────────

async function loadCronTriggers(metadataDir: string): Promise<CronTriggerConfig[]> {
  const cronPath = path.join(metadataDir, 'cron_triggers.yaml');
  const raw = await readYamlIfExists(cronPath);
  if (!raw || !Array.isArray(raw)) return [];

  return raw.map((entry) => RawCronTriggerSchema.parse(entry)).map(transformCronTrigger);
}

function transformCronTrigger(raw: RawCronTrigger): CronTriggerConfig {
  const webhook = raw.webhook ?? resolveEnv(raw.webhook_from_env) ?? '';

  return {
    name: raw.name,
    webhook,
    webhookFromEnv: raw.webhook_from_env,
    schedule: raw.schedule,
    payload: raw.payload,
    retryConf: raw.retry_conf
      ? {
          numRetries: raw.retry_conf.num_retries ?? 0,
          retryIntervalSeconds: raw.retry_conf.retry_interval_seconds ?? 10,
          timeoutSeconds: raw.retry_conf.timeout_seconds ?? 60,
          toleranceSeconds: raw.retry_conf.tolerance_seconds,
        }
      : undefined,
    headers: raw.headers?.map(transformHeader),
    comment: raw.comment,
  };
}

// ─── Hakkyra extension: api_config.yaml ─────────────────────────────────────

async function loadApiConfig(metadataDir: string): Promise<RawApiConfig | null> {
  const apiConfigPath = path.join(metadataDir, 'api_config.yaml');
  let raw = await readYamlIfExists(apiConfigPath);
  if (!raw) {
    const parentPath = path.join(path.dirname(metadataDir), 'api_config.yaml');
    raw = await readYamlIfExists(parentPath);
  }
  if (!raw || typeof raw !== 'object') return null;

  // .strict() on RawApiConfigSchema now rejects unknown fields automatically
  const config = RawApiConfigSchema.parse(raw);
  return config;
}

function transformRESTConfig(apiConfig: RawApiConfig | null): RESTConfig {
  const rest = apiConfig?.rest;
  const raw = {
    ...stripUndefined({
      autoGenerate: rest?.auto_generate,
      basePath: rest?.base_path,
    }),
    pagination: stripUndefined({
      defaultLimit: rest?.pagination?.default_limit,
      maxLimit: rest?.pagination?.max_limit,
    }),
    overrides: rest?.overrides as RESTConfig['overrides'],
  };
  return InternalRESTConfigSchema.parse(raw);
}

function transformCustomQueries(apiConfig: RawApiConfig | null): CustomQueryConfig[] {
  if (!apiConfig?.custom_queries) return [];
  return apiConfig.custom_queries.map((q) => ({
    name: q.name,
    type: q.type,
    sql: q.sql,
    params: q.params,
    returns: q.returns,
    permissions: q.permissions?.map((p) => ({
      role: p.role,
      filter: p.filter as BoolExp | undefined,
    })),
  }));
}

function transformDocsConfig(apiConfig: RawApiConfig | null): APIDocsConfig {
  const docs = apiConfig?.docs;
  return {
    generate: docs?.generate ?? true,
    output: docs?.output,
    llmFormat: docs?.llm_format,
    includeExamples: docs?.include_examples,
  };
}

// ─── Server config ──────────────────────────────────────────────────────────

async function loadServerConfig(configPath?: string): Promise<RawServerConfig | null> {
  if (!configPath) {
    const defaultPaths = ['hakkyra.yaml', 'hakkyra.yml', 'config.yaml', 'config.yml'];
    for (const p of defaultPaths) {
      const fullPath = path.resolve(p);
      if (await fileExists(fullPath)) {
        const raw = await readYaml(fullPath);
        return RawServerConfigSchema.parse(raw);
      }
    }
    return null;
  }
  const raw = await readYamlIfExists(path.resolve(configPath));
  if (!raw) {
    log.warn({ path: configPath }, 'Server config file not found');
    return null;
  }
  return RawServerConfigSchema.parse(raw);
}

function transformJobQueueConfig(serverConfig: RawServerConfig | null): JobQueueConfig | undefined {
  const jq = serverConfig?.job_queue;
  if (!jq) return undefined;

  return InternalJobQueueConfigSchema.parse(stripUndefined({
    provider: jq.provider,
    connectionString: jq.connection_string,
    redis: jq.redis
      ? stripUndefined({
          url: jq.redis.url,
          host: jq.redis.host,
          port: jq.redis.port,
          password: jq.redis.password,
        })
      : undefined,
  }));
}

function transformRedisConfig(serverConfig: RawServerConfig | null) {
  // Priority 1: explicit top-level redis config
  if (serverConfig?.redis) {
    return stripUndefined({
      url: serverConfig.redis.url,
      host: serverConfig.redis.host,
      port: serverConfig.redis.port,
      password: serverConfig.redis.password,
    });
  }
  // Priority 2: inherit from job_queue.redis if provider is bullmq
  if (serverConfig?.job_queue?.provider === 'bullmq' && serverConfig.job_queue.redis) {
    return stripUndefined({
      url: serverConfig.job_queue.redis.url,
      host: serverConfig.job_queue.redis.host,
      port: serverConfig.job_queue.redis.port,
      password: serverConfig.job_queue.redis.password,
    });
  }
  return undefined;
}

function transformAuth(serverConfig: RawServerConfig | null): AuthConfig {
  const auth = serverConfig?.auth;
  if (!auth) return {};

  const raw: Record<string, unknown> = {};

  if (auth.jwt) {
    raw.jwt = stripUndefined({
      type: auth.jwt.type,
      key: auth.jwt.key,
      keyEnv: auth.jwt.key_from_env,
      jwkUrl: auth.jwt.jwk_url,
      claimsNamespace: auth.jwt.claims_namespace,
      claimsMap: auth.jwt.claims_map,
      audience: auth.jwt.audience,
      issuer: auth.jwt.issuer,
      requireExp: auth.jwt.require_exp,
      adminRoleIsAdmin: auth.jwt.admin_role_is_admin,
    });
  }

  if (auth.admin_secret_from_env) {
    raw.adminSecretEnv = auth.admin_secret_from_env;
  }

  if (auth.unauthorized_role) {
    raw.unauthorizedRole = auth.unauthorized_role;
  }

  if (auth.webhook) {
    raw.webhook = stripUndefined({
      url: auth.webhook.url ?? resolveEnv(auth.webhook.url_from_env) ?? '',
      urlFromEnv: auth.webhook.url_from_env,
      mode: auth.webhook.mode,
      forwardHeaders: auth.webhook.forward_headers,
    });
  }

  return InternalAuthConfigSchema.parse(raw);
}
