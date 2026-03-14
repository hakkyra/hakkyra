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
} from './types.js';
import { IncludeRef } from './types.js';
import {
  RawVersionYamlSchema,
  RawDatabaseEntrySchema,
  RawDatabasesYamlSchema,
  RawTableYamlSchema,
  RawActionSchema,
  RawActionsYamlSchema,
  RawCronTriggerSchema,
  RawApiConfigSchema,
  RawServerConfigSchema,
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

  const version = await loadVersion(absMetadataDir);
  const databases = await loadDatabases(absMetadataDir);
  const tables = await loadAllTables(absMetadataDir);
  const actions = await loadActions(absMetadataDir);
  const actionsGraphql = await loadActionsGraphql(absMetadataDir);
  const cronTriggers = await loadCronTriggers(absMetadataDir);
  const apiConfig = await loadApiConfig(absMetadataDir);
  const serverConfig = await loadServerConfig(serverConfigPath);

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
    }) ?? {},
    auth: transformAuth(serverConfig),
    databases: transformDatabases(databases, serverConfig),
    tables,
    actions,
    actionsGraphql: actionsGraphql ?? undefined,
    cronTriggers,
    rest: transformRESTConfig(apiConfig),
    customQueries: transformCustomQueries(apiConfig),
    apiDocs: transformDocsConfig(apiConfig),
    tableAliases,
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
    }),
    eventCleanup: stripUndefined({
      schedule: serverConfig?.event_cleanup?.schedule,
    }),
    webhook: stripUndefined({
      timeoutMs: serverConfig?.webhook?.timeout_ms,
      backoffCapSeconds: serverConfig?.webhook?.backoff_cap_seconds,
    }),
    actionDefaults: stripUndefined({
      timeoutSeconds: serverConfig?.action_defaults?.timeout_seconds,
      asyncRetryLimit: serverConfig?.action_defaults?.async_retry_limit,
      asyncRetryDelaySeconds: serverConfig?.action_defaults?.async_retry_delay_seconds,
      asyncTimeoutSeconds: serverConfig?.action_defaults?.async_timeout_seconds,
    }),
    sql: stripUndefined({
      arrayAnyThreshold: serverConfig?.sql?.array_any_threshold,
      unnestThreshold: serverConfig?.sql?.unnest_threshold,
      batchChunkSize: serverConfig?.sql?.batch_chunk_size,
    }),
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

async function loadDatabases(metadataDir: string): Promise<RawDatabaseEntry[]> {
  const dbPath = path.join(metadataDir, 'databases', 'databases.yaml');
  const raw = await readYamlIfExists(dbPath);
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map((entry) => RawDatabaseEntrySchema.parse(entry));
  }
  if (typeof raw === 'object' && raw !== null && 'databases' in raw) {
    const parsed = RawDatabasesYamlSchema.parse(raw);
    return parsed.databases ?? [];
  }
  return [];
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

async function loadAllTables(metadataDir: string): Promise<TableInfo[]> {
  const tables: TableInfo[] = [];

  const databasesDir = path.join(metadataDir, 'databases');
  if (!(await fileExists(databasesDir))) return tables;

  let entries: string[];
  try {
    entries = await fs.readdir(databasesDir);
  } catch {
    return tables;
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
      const tableConfig = RawTableYamlSchema.parse(rawTable);
      if (!tableConfig.table) continue;
      tables.push(transformTable(tableConfig));
    }
  }

  return tables;
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
      perms.select[entry.role] = {
        columns: entry.permission.columns,
        filter: entry.permission.filter as BoolExp,
        limit: entry.permission.limit,
        allowAggregations: entry.permission.allow_aggregations,
        computedFields: entry.permission.computed_fields,
      };
    }
  }

  if (raw.insert_permissions) {
    for (const entry of raw.insert_permissions) {
      perms.insert[entry.role] = {
        columns: entry.permission.columns,
        check: entry.permission.check as BoolExp,
        set: entry.permission.set,
        backendOnly: entry.permission.backend_only,
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
  };
}

function transformHeader(raw: RawHeader): WebhookHeader {
  return {
    name: raw.name,
    value: raw.value,
    valueFromEnv: raw.value_from_env,
  };
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
      kind: raw.definition.kind || undefined,
      type: raw.definition.type || undefined,
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

  const config = RawApiConfigSchema.parse(raw);
  const knownFields = new Set([
    'table_aliases',
    'custom_queries',
    'rest',
    'docs',
    'tableAliases',
    'customQueries',
    'apiDocs',
  ]);
  for (const key of Object.keys(config)) {
    if (!knownFields.has(key)) {
      log.warn({ field: key }, 'Unrecognized field in api_config.yaml');
    }
  }

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
