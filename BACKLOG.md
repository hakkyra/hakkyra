# Hakkyra Backlog

## Phase 1: Core Engine (MVP) — COMPLETE

### P1.1 — Project Setup
- [x] Initialize Node.js project with TypeScript
- [x] Configure tsconfig.json, ESLint, Vitest
- [x] Install core dependencies (fastify, mercurius, pg, jose, pg-boss, pg-listen, pino)
- [x] Create directory structure
- [x] Define shared type definitions (src/types.ts)
- [x] PostgreSQL 17+ minimum (docker-compose)

### P1.2 — Configuration Loader (`src/config/`)
- [x] Define TypeScript types for all config structures (Hasura-compatible metadata format + extensions)
- [x] YAML parser with `!include` tag support
- [x] Load `version.yaml`, `databases.yaml`, per-table YAML files
- [x] ~~Load `api_config.yaml`~~ — removed; REST/docs config now in `hakkyra.yaml`
- [x] Load `actions.yaml` + `actions.graphql`
- [x] Load `cron_triggers.yaml`
- [x] Config validation (version, port, permissions, cron expressions, operators)
- [x] Integration tests for config loading (19 tests)
- [x] Config watcher for dev mode hot reload (`src/config/watcher.ts`, `--dev` CLI flag)

### P1.3 — PostgreSQL Introspection (`src/introspection/`)
- [x] Connect and introspect tables, views, materialized views
- [x] Extract columns (including materialized view columns via pg_attribute)
- [x] Extract primary keys, unique constraints
- [x] Extract foreign key relationships
- [x] Extract indexes (for permission filter optimization hints)
- [x] Extract enums, composite types, domains
- [x] Extract functions (for computed fields)
- [x] Map PG types → GraphQL scalar types
- [x] Merge introspection results with YAML config into internal schema model
- [x] Auto-detect relationships from FKs for column mapping resolution; only expose config-defined relationships
- [x] Validate: warn about config referencing non-existent tables/columns
- [x] Integration tests against real PG 17 database (30 tests)

### P1.4 — Authentication (`src/auth/`)
- [x] JWT verification using jose (HS256, RS256, ES256, Ed25519)
- [x] JWKS endpoint support with auto-rotation via `createRemoteJWKSet`
- [x] Claims extraction compatible with Hasura claims format (configurable namespace, claims_map)
- [x] Active role resolution (x-hasura-role header override if in allowed-roles)
- [x] Admin secret authentication bypass (timing-safe comparison)
- [x] Unauthorized/anonymous role fallback
- [x] Fastify preHandler hook (fastify-plugin for encapsulation bypass)
- [x] Session variables type + builder
- [x] E2E auth tests (expired JWT, admin secret, role override, malformed header)
- [x] Webhook-based authentication (GET/POST mode, header forwarding, in-memory TTL cache)
  - [x] Response parsing compatible with Hasura format (X-Hasura-Role, X-Hasura-User-Id, etc.)
  - [x] Auth chain: admin secret → JWT → webhook → unauthorized role

### P1.5 — Permission Compiler (`src/permissions/`)
- [x] Parse permission format from config (Hasura-compatible operators)
- [x] Compile permission rules to SQL AST at startup
- [x] All comparison operators (_eq, _ne, _gt, _lt, _gte, _lte, _in, _nin, _is_null)
- [x] Text operators (_like, _nlike, _ilike, _nilike, _similar, _regex, _iregex)
- [x] JSONB operators (_contains, _contained_in, _has_key, _has_keys_any, _has_keys_all)
- [x] Logical operators (_and, _or, _not)
- [x] Relationship operator (_exists)
- [x] Relationship traversal in permission filters (compile to EXISTS subqueries)
- [x] Session variable resolution (X-Hasura-* → JWT claim values)
- [x] Computed field references in permission filters (emit function calls instead of column refs)
- [x] Column-level permission enforcement (allowed columns per role per operation)
- [x] Column presets (set) for insert/update — rejected at input if provided by caller, applied from session/literal at runtime
- [x] Row limit enforcement
- [x] Aggregation permission flag
- [x] Admin role bypass
- [x] Permission lookup: Map<table+role+operation, CompiledPermission>
- [x] Unit tests: all operators, session variable substitution, computed fields, relationship traversal, edge cases (41 tests)

### P1.6 — SQL Query Compiler (`src/sql/`)
- [x] SELECT compiler with json_build_object response shaping
  - [x] Basic column selection
  - [x] WHERE clause from GraphQL `where` args (BoolExp → SQL)
  - [x] ORDER BY with direction + LIMIT/OFFSET (subquery wrapping)
  - [x] Permission WHERE injection
  - [x] Column restriction from permissions
- [x] SELECT with relationships (SQL compiler level)
  - [x] Object relationships via correlated subquery with json_build_object
  - [x] Array relationships via correlated subquery with jsonb_agg
  - [x] Nested relationship depth (recursive, table aliases t0/t1/t2...)
  - [x] Permission injection at each relationship level
- [x] SELECT by primary key
- [x] SELECT aggregate (count, sum, avg, min, max)
- [x] INSERT compiler (single + bulk, RETURNING, column presets, CTE check)
- [x] UPDATE compiler (by PK + bulk, permission filter, post-update check)
- [x] DELETE compiler (by PK + bulk, permission filter)
- [x] Parameter collection and safe parameterization ($1, $2, ...)
- [x] Integration tests against real PostgreSQL (24 tests)
- [x] GraphQL resolve info look-ahead for SQL column selection (`src/schema/resolve-info.ts`)
  - [x] Parse ResolveInfo selection set → requested columns + relationships
  - [x] Fragment spread and inline fragment support
  - [x] camelCase → snake_case field name remapping
- [x] Relationship selection from GraphQL resolve info → SQL subqueries
  - [x] Recursive nested relationship parsing with argument extraction
  - [x] Permission lookup per remote table at each nesting level
- ~~Custom query override support~~ (removed — use Native Queries instead)
- [x] Query caching: LRU cache for compiled SQL templates by (queryHash, role) (`src/sql/cache.ts`)

### P1.7 — GraphQL Schema Generator (`src/schema/`)
- [x] Generate GraphQLObjectType per tracked table
  - [x] Map PG columns → GraphQL fields with correct scalar types
  - [x] Apply custom_root_fields from config
  - [x] Add relationship fields (object + array)
- [x] Generate filter input types (BoolExp per table, camelCase field names)
- [x] Generate order_by input types (camelCase)
- [x] Generate mutation input types (camelCase: InsertInput with all-optional fields for per-role runtime validation, SetInput, PkColumnsInput)
- [x] Generate aggregate types (count, sum, avg, min, max, nodes)
- [x] Generate MutationResponse type (affectedRows, returning)
- [x] Register Query root fields (camelCase: e.g. users, userByPk, usersAggregate)
- [x] Register Mutation root fields (e.g. insertUsers, updateUserByPk, pkColumns arg)
- [x] Register Subscription root fields
- [x] Resolver factory wired to SQL compiler (all 9 resolvers)
  - [x] SELECT list, by PK, aggregate resolvers
  - [x] INSERT, INSERT_ONE resolvers
  - [x] UPDATE, UPDATE_BY_PK resolvers
  - [x] DELETE, DELETE_BY_PK resolvers
  - [x] camelCase ↔ snake_case BoolExp remapping
  - [x] camelCase response keys emitted directly in SQL json_build_object (no post-processing needed)
- [x] Custom scalar types (UUID, DateTime, JSON, JSONB, BigInt, BigDecimal, etc.)
- [x] graphql-default naming convention
  - [x] PascalCase type names
  - [x] camelCase field/argument names (columns and relationship fields)
  - [x] UPPER_CASED enum values
- [x] Schema tests (34 tests)
- [x] Relationship resolution via GraphQL resolve info (`src/schema/resolve-info.ts`)
  - [x] Object, array, and nested multi-level relationships (single SQL query)
  - [x] E2E tests: nested object, array, and multi-level relationship resolution (single SQL query)

### P1.8 — REST API Generator (`src/rest/`)
- [x] Route registration for each tracked table (CRUD)
- [x] Query parameter parser (PostgREST-style filters)
- [x] Same permission/auth enforcement as GraphQL (shared SQL compiler)
- [x] Proper HTTP status codes (200, 201, 204, 400, 401, 403, 404)
- [x] REST filter parsing tests (30 tests)
- [x] E2E REST tests (list, get, insert, update, delete, permission enforcement)
- [x] REST endpoint overrides from config (custom paths, default_order per operation) — now in `hakkyra.yaml`

### P1.9 — Connection Manager (`src/connections/`)
- [x] Primary pool creation from config
- [x] Replica pool(s) creation from config
- [x] Read/write routing (queries → replica, mutations → primary)
- [x] Round-robin across multiple replicas
- [x] Pool health checks
- [x] Graceful shutdown (drain connections)
- [x] Session variable injection via set_config() for SQL function access
  - [x] `hasura.user` — full session claims JSON
  - [x] `hakkyra.user_id` — authenticated user ID
  - [x] `hakkyra.role` — active role

### P1.10 — Server Wiring (`src/server.ts`, `src/index.ts`)
- [x] Fastify server setup
- [x] Mercurius GraphQL plugin registration (ESM/CJS schema bridging)
- [x] Auth preHandler hook (registered before Mercurius)
- [x] Mercurius context builder (ResolverContext with queryWithSession + queryCache)
- [x] REST route registration (with override support)
- [x] Health check endpoint (/healthz, /readyz)
- [x] Graceful shutdown handler (Phase 2 services + connection pools)
- [x] CLI entry point with --port, --host, --config, --metadata, --dev flags
- [x] Dev mode: config watcher + Mercurius `replaceSchema()` hot reload
- [x] E2E tests: health endpoints, doc endpoints (59 tests total)

### P1.11 — API Documentation Generator (`src/docs/`)
- [x] OpenAPI 3.1 spec generation (/openapi.json)
- [x] LLM-friendly compact JSON format (/llm-api.json)
- [x] Serve docs at configured endpoints
- [x] GraphQL SDL export with descriptions (`GET /sdl`)

### P1.12 — Test Infrastructure
- [x] Docker Compose with PostgreSQL 17
- [x] Test fixtures: 19 tables + 1 materialized view + 5 enums + 1 table-based enum + 3 computed fields
- [x] YAML metadata in Hasura-compatible format (19 table configs, 5 roles, 3 inherited roles)
- [x] Event triggers, cron triggers, actions, REST endpoints, query collections
- [x] Seed data: fixture data for all tracked tables
- [x] JWT test helpers (HS256 tokens for test roles)

---

## Phase 2: Real-time & Events — COMPLETE

### Shared Infrastructure (`src/shared/`)
- [x] Webhook delivery utility (fetch-based, timeout, header/URL env resolution, `{{ENV_VAR}}` template interpolation)
- [x] pg-boss lifecycle manager (start, graceful stop, `hakkyra_boss` schema)
- [x] Exponential backoff calculator

### P2.1 — Subscriptions (`src/subscriptions/`)
- [x] Install PG trigger function (`hakkyra.notify_change()`) on tracked tables
- [x] pg-listen subscriber for LISTEN/NOTIFY on `hakkyra_changes` channel
- [x] Subscription manager: registry, table index, hash-diff, debounced re-query
- [x] On PG notification: find affected subscriptions, re-query, push if result changed
- [x] Graceful unsubscription and cleanup
- [x] Mercurius subscribe resolvers (AsyncIterable wiring for graphql-ws protocol)
- [x] Connection authentication (JWT from WebSocket connectionParams)
- [x] Subscription keep-alive / ping-pong (Mercurius `keepAlive` option, 30s)
- [x] Integration tests (13 tests: WebSocket auth, initial data, live INSERT/UPDATE/DELETE, permissions, cleanup)

### P2.2 — Event Triggers (`src/events/`)
- [x] Create `hakkyra` schema + `hakkyra.event_log` table on startup
- [x] Install per-table PG trigger functions (INSERT/UPDATE/DELETE → event_log)
- [x] Column-specific UPDATE triggers (only fire when tracked columns change)
- [x] Session variable capture in triggers (`current_setting('hasura.user')`)
- [x] pg-listen subscriber for `hakkyra_events` NOTIFY channel
- [x] Job queue workers: fetch pending events, deliver webhooks
- [x] Webhook payload format (compatible with Hasura event payload)
- [x] Retry with exponential backoff (per-trigger retry config)
- [x] Dead letter queue (status → 'failed' after retries exhausted)
- [x] Event delivery status tracking (pending/processing/delivered/failed)
- [x] Startup catchup: enqueue events missed during downtime
- [x] Cleanup: daily scheduled job deletes delivered events older than retention period
- [x] Manual event trigger invocation API (`POST /v1/events/invoke/:trigger`)
- [x] Integration tests (9 tests)

### P2.3 — Cron Triggers (`src/crons/`)
- [x] Load cron_triggers.yaml (already handled by config loader)
- [x] Register crons via job queue (distributed single-execution via advisory locks)
- [x] Webhook delivery with retry (job queue retry config: limit, delay, backoff)
- [x] Webhook payload format compatible with Hasura cron payload
- [x] Integration tests (14 tests)

### Server Integration
- [x] Phase 2 modules wired into `src/server.ts` startup sequence
- [x] Graceful shutdown: change listener → event manager → job queue → server → pools
- [x] Graceful degradation: Phase 2 skips with warning if job queue fails to connect

---

## Phase 3: Advanced Features — COMPLETE

### P3.1 — Actions (`src/actions/`)
- [x] Load actions.yaml + actions.graphql
- [x] Parse GraphQL type definitions for action inputs/outputs
- [x] Webhook proxy mode (compatible with Hasura action format)
  - [x] Forward input + session variables to handler URL
  - [x] Header forwarding (configured headers + client header forwarding)
  - [x] Request/response transformation — template interpolation engine (32 tests)
- [x] Async actions (return immediately, deliver result later, 18 tests)
- [x] Action permissions per role (checks all allowed roles from JWT, not just active role — Hasura-compatible)
- [x] Action relationship mapping — object/array relationships to DB tables (13 tests)
- [x] Inline arguments support — actions with direct args (Hasura default) in addition to wrapped input types
- [x] Integration tests (19 tests)

### P3.1.5 — Job Queue Abstraction (`src/shared/job-queue/`)
- [x] `JobQueue` interface abstracting pg-boss
- [x] `PgBossAdapter` + `BullMQAdapter` (optional, requires Redis)
- [x] Factory function with config-driven provider selection
- [x] All consumers refactored to use `JobQueue` interface

### P3.2 — Advanced SQL Features
- [x] Computed fields (from PG functions, 17 tests)
- [x] ON CONFLICT (upsert) for inserts (22 tests)
- [x] Distinct queries — DISTINCT ON (22 tests)
- [x] Returning nested relationships and computed fields after mutations (16 tests)
- [x] GROUP BY support in aggregations (18 tests)
- [x] Batch operations optimization — UNNEST for large inserts, updateMany (26 tests)
- [x] Prepared statement caching — LRU-based, config-driven (13 tests)

### P3.3 — Read-Your-Writes Consistency
- [x] ConsistencyTracker with configurable window (default 5s, 15 tests)

---

## Phase 4: Polish & Production — COMPLETE

### P4.1 — CLI Tool — COMPLETE
- [x] `hakkyra start` — production start (`src/commands/start.ts`)
- [x] `hakkyra dev` — dev mode with hot reload
- [x] `hakkyra init` — scaffold project with example config (`src/commands/init.ts`)
- [x] `hakkyra --version` / `hakkyra --help`
- [x] Backwards-compatible flag-only invocations

### P4.1.5 — Zod Validation & Inferred Types — COMPLETE
- [x] Add `zod` dependency, remove unused `ajv`
- [x] Raw YAML Zod schemas (`src/config/schemas.ts`, 22 schemas)
- [x] Internal config Zod schemas (`src/config/schemas-internal.ts`, 24 schemas)
- [x] Zod `.parse()` at YAML loading boundaries in `src/config/loader.ts`
- [x] Raw config types in `src/config/types.ts` → `z.infer<>` from schemas
- [x] Config types in `src/types.ts` → `z.infer<>` (22 types)
- [x] Environment variable validation (`src/config/env.ts`) — fail-fast on missing vars
- [x] REST input validation (`src/rest/schemas.ts`) — body + pagination Zod schemas
- [x] Tests for Zod schemas (valid configs pass, invalid configs produce clear errors) — 214 tests

### P4.2 — Observability
- [x] Structured logging with pino (Fastify logger, connection manager)
- [x] Request/response logging (onResponse hook: method, URL, status, time, role, GraphQL op)
- [x] Slow query detection (`slow_query_threshold_ms`, default 200ms)

### P4.3 — Performance
- [x] Query plan caching (LRU cache for compiled SQL templates)
- [x] Trigger reconciliation — diff-based startup instead of DROP+CREATE all (`src/shared/trigger-reconciler.ts`)
  - [x] Query existing hakkyra triggers from pg_trigger/pg_proc in single query
  - [x] Diff desired (YAML) vs actual (DB) trigger sets
  - [x] Only CREATE new triggers, DROP orphaned triggers, skip unchanged
  - [x] `CREATE OR REPLACE FUNCTION` for event trigger functions (no data lock)
  - [x] Orphan cleanup: auto-remove triggers for tables removed from YAML
- [x] Connection pool tuning (`maxLifetime`, `allowExitOnIdle`, fix `connection_lifetime` mapping)

### P4.4 — Developer Experience
- [x] Docker image + docker-compose for quick start (`Dockerfile`, `docker-compose.quickstart.yml`)
- [x] GitHub Actions CI template (`.github/workflows/ci.yml`)

### P4.5 — Multi-Instance & PgBouncer Support — COMPLETE
- [x] Dual connection pool — dedicated session connection for LISTEN/NOTIFY (`databases.session.url_from_env`)
  - [x] `ConnectionManager.getSessionConnectionString()` with fallback to primary
  - [x] Config schemas (raw YAML + internal Zod) with session field
  - [x] Server wiring: event triggers + subscription listener use session connection
- [x] Redis pub/sub fanout for multi-instance subscriptions (`src/subscriptions/redis-fanout.ts`)
  - [x] `RedisFanoutBridge` with publish/subscribe via ioredis (optional dependency)
  - [x] Instance ID deduplication (skip own messages)
  - [x] Graceful fallback to single-instance mode without Redis
  - [x] Top-level `redis` config with auto-inherit from `job_queue.redis`
  - [x] Zod schema tests (228 tests, up from 214)

## Improvements

### Centralize Magic Defaults into Zod Schemas — COMPLETE
Move all hardcoded default values to Zod `.default()` in `src/config/schemas-internal.ts` so they are configurable, documented in one place, and validated at load time. Raw YAML schemas (`schemas.ts`) accept optional fields; internal schemas apply defaults via `.default()`. Loader strips undefined values and parses through `HakkyraConfigSchema.parse()`.

**Server & CLI** (`src/cli.ts`, `src/config/loader.ts`, `src/server.ts`)
- [x] `server.port` → `3000`
- [x] `server.host` → `'0.0.0.0'`
- [x] `server.logLevel` → `'info'`
- [x] `configPath` → `'./hakkyra.yaml'`, `metadataPath` → `'./metadata'` (exported as `CONFIG_DEFAULTS`)
- [x] `configWatcher.debounceMs` → `500` (exported as `CONFIG_DEFAULTS`)

**Database Pools** (`src/config/loader.ts`, `src/connections/manager.ts`)
- [x] `pool.max` → `10`
- [x] `pool.idleTimeout` → `30` (seconds)
- [x] `pool.connectionTimeout` → `5` (seconds)
- [x] `pool.maxLifetime` — mapped through schema (optional, no default)
- [x] `readYourWrites.windowSeconds` → `5`

**Caching** (`src/sql/cache.ts`, `src/server.ts`)
- [x] `queryCache.maxSize` → `1000`

**Subscriptions** (`src/subscriptions/manager.ts`, `src/server.ts`)
- [x] `subscription.debounceMs` → `50`
- [x] `subscription.keepAliveMs` → `30000`

**Event Triggers** (`src/events/delivery.ts`, `src/events/cleanup.ts`)
- [x] `eventLogRetentionDays` → `7`
- [x] `eventDelivery.batchSize` → `100`
- [x] `eventCleanup.schedule` → `'0 3 * * *'`
- [x] `slowQueryThresholdMs` → `200`

**Webhooks & Auth** (`src/shared/webhook.ts`, `src/auth/webhook.ts`, `src/actions/proxy.ts`)
- [x] `webhook.timeoutMs` → `30000`
- [x] `authWebhook.timeoutMs` → `5000` (auth webhook config, schema-level)
- [x] `authWebhook.cacheTtlMs` → `0` (auth webhook config, schema-level)
- [x] `authWebhook.mode` → `'GET'`
- [x] `backoff.capSeconds` → `3600`

**Actions** (`src/actions/async.ts`, `src/actions/proxy.ts`)
- [x] `action.timeoutSeconds` → `30`
- [x] `asyncAction.retryLimit` → `3`
- [x] `asyncAction.retryDelaySeconds` → `10`
- [x] `asyncAction.timeoutSeconds` → `120`

**JWT** (`src/config/loader.ts`)
- [x] `jwt.type` → `'HS256'`

**Job Queue** (`src/shared/pg-boss-manager.ts`, `src/shared/job-queue/`)
- [x] `jobQueue.provider` → `'pg-boss'`
- [x] `jobQueue.gracefulShutdownMs` → `10000`
- [x] `redis.port` → `6379`

**SQL Optimization Thresholds** (`src/sql/where.ts`, `src/sql/insert.ts`)
- [x] `sql.arrayAnyThreshold` → `20`
- [x] `sql.unnestThreshold` → `500`
- [x] `sql.batchChunkSize` → `100`

**REST** (`hakkyra.yaml`)
- [x] `rest.defaultLimit` → `20`
- [x] `rest.maxLimit` → `100`
- [x] `rest.autoGenerate` → `true`
- [x] `rest.basePath` → `'/api'`

### Table Configuration: `column_config` and `custom_name`

Hasura's table `configuration` block supports `column_config` (per-column settings like `custom_name` and `comment`) and `custom_name` (table-level custom name). These override the `custom_column_names` shorthand with richer per-column config.

- [x] Accept `column_config` in table configuration Zod schema (record of column → `{ custom_name?, comment? }`)
- [x] Accept `custom_name` in table configuration Zod schema
- [x] Config loader: merge `column_config` custom names into `custom_column_names` (column_config takes precedence)
- [x] Config loader: apply table-level `custom_name` as table alias for type naming and root fields
- [x] `column_config.comment`: surface as GraphQL field descriptions

### Request Transform: `template_engine` and `version` ✅

Hasura v2 request transforms support `template_engine` (e.g. `"Kriti"`) and `version` fields. Schema validation accepts these fields; Hakkyra uses Kriti via the kriti-lang package (`src/actions/kriti.ts`).

- [x] Accept `template_engine` and `version` in request transform Zod schema
- [x] Transform engine: support Kriti template syntax (Hasura's default template engine)

### Nested Insert Ordering (`insertion_order`)

Hasura supports `insertion_order` in object relationship `manual_configuration` to control whether the related row is inserted before or after the parent row in nested inserts. Values: `before_parent` (default) or `after_parent`.

- [x] Accept `insertion_order` in relationship manual_configuration Zod schema (nullable, optional)
- [x] INSERT compiler: respect `insertion_order` when compiling nested inserts — `before_parent` inserts child first (for FK on parent), `after_parent` inserts parent first (for FK on child)
- [x] Internal RelationshipConfig schema includes `insertionOrder` field
- [x] Config loader propagates `insertion_order` from YAML to internal config
- [x] Insert input types include nested relationship fields (object + array)
- [x] Resolver executes nested inserts in correct order within a single transaction
- [x] E2E tests for before_parent, after_parent, array relationships, combined, and rollback

### Remove `table_aliases` from `api_config.yaml` — COMPLETE

Default naming already applies `toPascalCase()` / `toCamelCase()` to table names automatically. `table_aliases` was redundant — Hasura metadata's `custom_name` on tables serves the same purpose.

- [x] Remove `table_aliases` from raw YAML schema, internal schema, loader, and type definitions
- [x] Remove `table_aliases` from test fixture `api_config.yaml`
- [x] Implement `custom_name` from Hasura table configuration as the table alias
- [x] Remove alias application in `loader.ts`

### Remove `custom_queries` mechanism — COMPLETE

Raw SQL endpoints replaced by Native Queries (P5.16).

- [x] Remove `custom_queries` from raw YAML schema, internal schema, loader
- [x] Remove `src/schema/custom-queries.ts`
- [x] Remove custom query E2E tests
- [x] Remove `custom_queries` from test fixture `api_config.yaml`

### Move REST and docs config from `api_config.yaml` to `hakkyra.yaml` — COMPLETE

REST pagination, base path, auto-generation, and doc generation are server runtime config, not metadata. They belong alongside `server`, `graphql`, and other deployment-level settings in `hakkyra.yaml`.

- [x] Add `rest` section to `hakkyra.yaml` raw schema (auto_generate, base_path, pagination, overrides)
- [x] Add `docs` section to `hakkyra.yaml` raw schema (generate, llm_format, output)
- [x] Update loader to read rest/docs from server config instead of api_config
- [x] Update test fixtures (`hakkyra.yaml` and `api_config.yaml`)
- [x] Remove `api_config.yaml` entirely (was empty after all config moved to `hakkyra.yaml`)
- [x] Remove dead `loadApiConfig()` code and empty `RawApiConfigSchema` from loader/schemas

### Configurable Session Variable Namespace

Hakkyra currently uses the `x-hasura-*` prefix for session variables (`x-hasura-role`, `x-hasura-user-id`, `x-hasura-allowed-roles`, etc.) inherited from Hasura compatibility. Allow overriding this namespace via `hakkyra.yaml` so deployments not migrating from Hasura can use a shorter, product-neutral prefix.

**Config**: `auth.session_namespace` in `hakkyra.yaml` (default: `x-hk`). Set to `x-hasura` for full Hasura backwards compatibility.

- [x] Add `session_namespace` field to `auth` section in raw YAML schema + internal schema (default: `x-hk`)
- [x] Auth middleware: use configured namespace when extracting/building session variables from JWT claims and webhook responses
- [x] Well-known variables use namespace prefix: `{ns}-role`, `{ns}-user-id`, `{ns}-allowed-roles`, `{ns}-default-role`
- [x] Permission compiler: resolve `x-hasura-*` references in YAML permission filters using the configured namespace (YAML always uses `x-hasura-*` for Hasura metadata compat; at runtime map to configured namespace)
- [x] Headers: accept both `x-hasura-role` and `{ns}-role` for role override header (prefer configured namespace)
- [x] JWT claims: support both `https://hasura.io/jwt/claims` and a configurable claims namespace key
- [x] 39 unit tests verifying default `x-hk` namespace and `x-hasura` backwards-compat mode
- [x] Central namespace utility module: `src/auth/session-namespace.ts` (nsKey, isSessionVariable, resolveSessionVar)

### Other Improvements
- [x] Dual connection pool — dedicated session-mode pool for LISTEN/NOTIFY, separate pooled connections for queries/mutations (enables PgBouncer transaction-mode compatibility)
- [x] Redis pub/sub fanout for multi-instance subscriptions

### JWT Admin Role as isAdmin — COMPLETE
- [x] Allow JWT users whose active role is `admin` to be treated as `isAdmin: true` (bypassing permission checks), controlled by `auth.jwt.admin_role_is_admin` config option (default: `false`). When enabled, `extractSessionVariables()` sets `isAdmin: true` when the resolved role equals `admin`. Role override via `x-hasura-role: admin` also sets `isAdmin: true`. 9 tests (5 unit + 4 E2E).

### Configurable Internal Schema Name — COMPLETE
- [x] Allow configuring the PostgreSQL schema name used for Hakkyra's internal objects via `server.schema_name` in `hakkyra.yaml` (default: `hakkyra`). Threaded through 18 files: event schema/triggers/delivery/cleanup/manager, subscription triggers/listener, trigger reconciler, pg-boss manager, job queue, connection manager, server. 5 new Zod schema tests.

### Strict YAML Validation — COMPLETE
- [x] All raw YAML Zod schemas (`src/config/schemas.ts`) changed from `.passthrough()` to `.strict()` — unknown/unrecognized fields in any YAML config now produce a clear error instead of being silently ignored.
- [x] Known-unsupported Hasura fields (`remote_relationships`, `apollo_federation_config`, `stored_procedures`, `backend_configs`, `customization`) and ignored fields (`validate_input`) are stripped from raw objects before strict parsing so that existing descriptive error messages are preserved.
- [x] Removed manual unknown-field warning in `loadApiConfig()` — `.strict()` handles this automatically.
- [x] Fixed latent bug: `backend_only` field on permission entries was accepted by `.passthrough()` but never declared in the schema; now explicitly defined.
- [x] 3 new E2E tests (unknown field in table YAML, database YAML, hakkyra.yaml); 2 updated Zod schema tests (verify strict rejection).

---

## Phase 5: Hasura Schema Compatibility — COMPLETE

Gaps identified by comparing Hasura's GraphQL schema (extracted with admin rights from production metadata) against Hakkyra's live SDL. These are the differences that prevent Hakkyra from being a drop-in replacement.

### P5.1 — Operator & Naming Convention (Critical) — COMPLETE

Change all operators and enums to match Hasura's exact naming.

- [x] Rename `_ne` → `_neq` (all comparison types)
- [x] Rename `_is_null` → `_isNull` (all comparison types)
- [x] Rename `_contained_in` → `_containedIn` (JSONB comparison)
- [x] Rename `_has_key` → `_hasKey` (JSONB comparison)
- [x] Rename `_has_keys_all` → `_hasKeysAll` (JSONB comparison)
- [x] Rename `_has_keys_any` → `_hasKeysAny` (JSONB comparison)
- [x] OrderBy enum: change to UPPER_CASE values (`ASC`, `DESC`, `ASC_NULLS_FIRST`, `ASC_NULLS_LAST`, `DESC_NULLS_FIRST`, `DESC_NULLS_LAST`)
- [x] Update all tests to use new operator/enum names
- [x] Permission compiler accepts both old YAML names and new GraphQL names via compat aliases

### P5.2 — Tracked Functions as Root Fields (Critical) — COMPLETE

Hasura exposes PostgreSQL functions as top-level Query/Mutation fields. The metadata tracks 39 functions. The schema exposes `latestWins(args: LatestWinsArgs): [BigWin!]!` and `acceptContractWithToken(args: AcceptContractWithTokenArgs!): PlayerContract` as examples.

- [x] Load `functions.yaml` from Hasura metadata (already has `!include` support)
- [x] Parse function metadata: `function.name`, `function.schema`, `configuration.exposed_as` (query/mutation), `configuration.custom_root_fields`, `permissions`
- [x] Introspect PG function signatures: input args → GraphQL input type, return type → existing table type
- [x] Generate `{functionName}Args` input type from function parameters
- [x] Register function as Query root field (default) or Mutation root field (`exposed_as: mutation`)
- [x] Support function aggregate variant (`{functionName}Aggregate`) for functions returning SETOF table
- [x] Permission enforcement per role on function fields
- [x] Wire resolver: call function via SQL `SELECT * FROM schema.function_name(args)`, map result to table type
- [x] 20 tests (config loading, introspection, schema gen, E2E query/mutation, permissions, aggregates)

### P5.3 — Relationship Ordering (High) — COMPLETE

Hasura allows ordering by nested relationship fields (e.g., `orderBy: { currency: { name: ASC } }`) and by array relationship aggregates (e.g., `orderBy: { gamesAggregate: { count: DESC } }`).

- [x] Support object relationship fields in OrderBy input types (e.g., `BigWinOrderBy.currency: CurrencyOrderBy`)
- [x] Generate `{Table}AggregateOrderBy` types for array relationships
- [x] Generate per-function aggregate order types (`{Table}AvgOrderBy`, `{Table}MaxOrderBy`, `{Table}MinOrderBy`, `{Table}SumOrderBy`, `{Table}StddevOrderBy`, etc.)
- [x] Add `{rel}Aggregate: {Rel}AggregateOrderBy` field to parent OrderBy types
- [x] SQL compiler: translate relationship ordering to LEFT JOIN + ORDER BY, aggregate ordering to correlated subquery
- [x] 15 tests (schema types, SQL compilation, E2E ordering)

### P5.4 — Aggregate BoolExp — Filter by Array Relationship Aggregates (High) — COMPLETE

Hasura allows filtering parent rows by aggregate values of their array relationships (e.g., "find game_integrations where count of currencies > 5").

- [x] Generate `{Table}AggregateBoolExp` types for each array relationship
- [x] Generate `{table}AggregateBoolExpCount` helper input (lowercase-start name, Hasura convention)
- [x] Add `{rel}Aggregate: {Rel}AggregateBoolExp` field to parent BoolExp types
- [x] SQL compiler: translate aggregate bool_exp to correlated subquery with predicate
- [x] 6 schema tests

### P5.5 — Statistical Aggregate Functions (Medium) — COMPLETE

Hasura generates stddev/variance aggregate field types. Hakkyra only has count/sum/avg/min/max.

- [x] `stddev` — sample standard deviation
- [x] `stddevPop` — population standard deviation
- [x] `stddevSamp` — sample standard deviation (alias)
- [x] `variance` — sample variance
- [x] `varPop` — population variance
- [x] `varSamp` — sample variance (alias)
- [x] Generate `{Table}StddevFields`, `{Table}StddevPopFields`, `{Table}StddevSampFields`, `{Table}VarPopFields`, `{Table}VarSampFields`, `{Table}VarianceFields` types
- [x] SQL compiler: emit `stddev()`, `stddev_pop()`, `stddev_samp()`, `variance()`, `var_pop()`, `var_samp()`
- [x] Support in GROUP BY aggregations
- [x] REST aggregate endpoint support
- [x] 15 new tests (8 SQL compiler + 7 GraphQL E2E)

### P5.6 — Streaming Subscriptions (Medium) — COMPLETE

Hasura supports cursor-based streaming subscriptions (`{table}Stream`) with `batchSize`, `cursor`, and `where` arguments.

- [x] Generate `{Table}StreamCursorInput` types (`initialValue` + `ordering`)
- [x] Generate `{Table}StreamCursorValueInput` types (all columns as optional fields)
- [x] Generate `CursorOrdering` enum (`ASC`, `DESC`)
- [x] Register `{table}Stream` subscription fields with `batchSize: Int!`, `cursor: [{Table}StreamCursorInput]!`, `where` args
- [x] Implement streaming: use cursor value to filter rows > cursor, batch delivery
- [x] 15 tests (13 schema + 2 E2E)

### P5.7 — Array Comparison Types (Medium) — COMPLETE

Hasura generates `StringArrayComparisonExp` (and likely others) for PostgreSQL array columns (`text[]`, `int[]`, etc.).

- [x] Detect PostgreSQL array column types during introspection
- [x] Generate `{ScalarType}ArrayComparisonExp` input types with Hasura operators: `_contains`, `_containedIn`, `_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_nin`, `_isNull`
- [x] SQL compiler: translate array operators to PG operators (`@>`, `<@`, `=`, etc.) with column-type-aware disambiguation from JSONB
- [x] Map array columns to `[ScalarType!]` in object types
- [x] 24 tests (11 schema + 13 E2E)

### P5.8 — JSONB Path Argument (Medium) — COMPLETE

Hasura supports a `path: String` argument on JSONB fields to select nested JSON paths (e.g., `value(path: "nested.key")`).

- [x] Add optional `path: String` argument to JSONB-typed fields in object types
- [x] SQL compiler: when `path` is provided, emit `column #> $N::text[]` with parameterized path segments
- [x] Support in select, selectByPk, relationships, computed fields, and mutation RETURNING clauses
- [x] 13 tests (3 schema + 5 SQL compiler + 5 E2E)

### P5.9 — JSONB Cast Expression (Low) — COMPLETE

Hasura's `JsonbComparisonExp` has a `_cast` field (`JsonbCastExp { String: StringComparisonExp }`) allowing you to cast JSONB to string for string comparison operators.

- [x] Generate `JsonbCastExp` input type
- [x] Add `_cast: JsonbCastExp` to `JsonbComparisonExp`
- [x] SQL compiler: emit `(column)::text` cast when `_cast.String` is used
- [x] 8 tests (2 schema + 4 SQL compiler + 2 E2E)

### P5.10 — Scalar Type Naming (Low) — COMPLETE

Rename scalars to match Hasura's exact names.

| Hasura | Hakkyra (previous) | Action |
|--------|-------------------|--------|
| `Uuid` | `UUID` | Renamed |
| `Bigint` | `BigInt` | Renamed |
| `Numeric` | `BigDecimal` | Renamed |
| `Jsonb` | `JSONB` | Renamed |
| `json` (lowercase) | `JSON` | Renamed |
| `Bpchar` | `String` | Added new scalar |
| `Timestamptz` | `DateTime` | Consolidated |

- [x] Rename all scalar types to match Hasura naming
- [x] Add `Bpchar` scalar with `BpcharComparisonExp` (same operators as StringComparisonExp)
- [x] Generate `NumericComparisonExp`, `BigintComparisonExp`, `BpcharComparisonExp`, `UuidComparisonExp`, `TimestamptzComparisonExp`
- [x] Update type-map to use Hasura scalar names
- [x] Separate `json` and `jsonb` into distinct scalars

### P5.11 — Root Type Naming (Low) — COMPLETE

Change root type names to match Hasura.

- [x] Rename `Query` → `query_root`
- [x] Rename `Mutation` → `mutation_root`
- [x] Rename `Subscription` → `subscription_root`
- [x] `schema { query: query_root, ... }` declaration emitted automatically by `printSchema`

### P5.12 — Inherited Roles (Medium) — COMPLETE

Hasura supports inherited roles where a composite role inherits the union of permissions from its constituent roles (`inherited_roles.yaml`).

- [x] Load `inherited_roles.yaml` from metadata directory (`role_name` → `role_set` mapping)
- [x] Store inherited roles in `HakkyraConfig` as `Record<string, string[]>`
- [x] Table permissions: merge constituent role permissions at `buildPermissionLookup` time
  - [x] SELECT: columns = union, filter = OR, allowAggregations = any, limit = max
  - [x] INSERT: columns = union, check = OR
  - [x] UPDATE: columns = union, filter = OR, check = OR
  - [x] DELETE: filter = OR
- [x] Tracked function permissions: check constituent roles when inherited role not directly listed
- [x] Hot-reload support: inherited roles updated on config change

### P5.13 — Table-Based Enums (`is_enum`) (Medium) — COMPLETE

Hasura supports marking a table as `is_enum: true` in metadata, turning its primary key values into a GraphQL enum type. Columns with foreign keys to enum tables are typed as the enum instead of String.

- [x] Parse `is_enum: true` from table YAML metadata (top-level field)
- [x] Add `isEnum` flag to `TableInfo` interface
- [x] Query enum table PK values from database at startup
- [x] Build GraphQL enum types from table values (reuses existing PG enum pipeline)
- [x] Override FK column types to use enum type (uppercase serialization: `'active'` → `ACTIVE`)
- [x] Remove auto-detected relationships pointing to enum tables (FK becomes enum scalar)
- [x] Exclude enum tables from queryable types (not exposed as GraphQL object types)
- [x] Hot-reload support (resolveTableEnums called on config change)
- [x] 3 E2E tests (enum value uppercasing, enum filtering, enum table not queryable)

### P5.14 — Query Collections & Hasura REST Endpoints (High) ✅

Hasura REST endpoints reference named queries stored in query collections. The neofix metadata has 57 queries in the `allowed-queries` collection and 50+ REST endpoints mapping URL paths to those queries.

#### Config Loader

- [x] Load `query_collections.yaml` — array of `{ name, definition: { queries: [{ name, query }] } }`
- [x] Store query collections in `HakkyraConfig` as `Map<collectionName, Map<queryName, queryString>>`
- [x] Load `rest_endpoints.yaml` — array of `{ name, url, methods, definition: { query: { collection_name, query_name } }, comment? }`
- [x] Validate that every REST endpoint references an existing collection + query
- [x] Remove `query_collections` and `rest_endpoints` from `UNSUPPORTED_METADATA_FILES`
- [x] Zod schemas for raw YAML + internal types

#### REST Endpoint Execution

- [x] Register Fastify routes from `rest_endpoints.yaml` definitions
- [x] Route pattern: `/{url}` with configurable base path (default `/api/rest`)
- [x] Support multiple HTTP methods per endpoint (`methods: [GET, POST]`)
- [x] Parse GraphQL query string from the referenced collection entry
- [x] Execute as a standard GraphQL query through the existing schema/resolver pipeline
- [x] Pass request body as GraphQL variables (POST), URL query params as variables (GET)
- [x] Apply same auth/permission enforcement as `/graphql` endpoint
- [x] Return GraphQL response (data/errors) as JSON

#### Tests

- [x] Config loader: load query collections and REST endpoints from neofix-style fixtures
- [x] Validation: error on REST endpoint referencing non-existent query
- [x] E2E: POST to REST endpoint executes referenced mutation
- [x] E2E: GET to REST endpoint executes referenced query with query params as variables
- [x] E2E: permission enforcement on REST endpoints (admin, role-based, unauthorized)

### P5.15 — GraphQL Introspection Control (Medium)

Hasura supports `disabled_for_roles` to block schema introspection for specific roles. The neofix metadata has `disabled_for_roles: []` (allow all).

- [x] Load `graphql_schema_introspection.yaml` — `{ disabled_for_roles: string[] }`
- [x] Remove `graphql_schema_introspection` from `UNSUPPORTED_METADATA_FILES`
- [x] Store in `HakkyraConfig.introspection.disabledForRoles`
- [x] Intercept introspection queries (`__schema`, `__type`) in the GraphQL resolver
- [x] Return error for roles listed in `disabledForRoles`
- [x] Empty array = introspection allowed for all roles (default behavior)
- [x] Tests: introspection blocked for listed role, allowed for unlisted role, empty array allows all

### P5.16 — Native Queries & Logical Models (High)

Hasura v2.28+ supports native queries (raw SQL exposed as GraphQL fields) with logical models (custom return types). The neofix metadata has 3 native queries with 3 logical models.

#### Config Loader

- [x] Load `native_queries` from database entries in `databases.yaml`
- [x] Load `logical_models` from database entries in `databases.yaml`
- [x] Remove `native_queries` and `logical_models` from `UNSUPPORTED_DATABASE_FIELDS`
- [x] Parse native query structure: `{ root_field_name, arguments: { name: { type, nullable? } }, code (SQL), returns (logical model name) }`
- [x] Parse logical model structure: `{ name, fields: [{ name, type, nullable? }], select_permissions: [{ role, permission: { columns, filter } }] }`
- [x] Zod schemas for raw YAML + internal types
- [x] Store in `HakkyraConfig.nativeQueries` and `HakkyraConfig.logicalModels`

#### Schema Generation

- [x] Generate GraphQL object type per logical model (field names, scalar types)
- [x] Generate GraphQL input type per native query for arguments
- [x] Register native queries as Query root fields (`root_field_name`)
- [x] SQL execution: interpolate `{{paramName}}` placeholders as parameterized values ($1, $2...)
- [x] Permission enforcement per logical model (role-based, with row-level filter using session variables)

#### Tests

- [x] Config loader: parse native queries and logical models from databases.yaml
- [x] Schema: logical model types appear in SDL
- [x] Schema: native query root fields appear with correct argument types
- [x] E2E: execute native query with arguments, verify result shape
- [x] E2E: permission enforcement — role with access vs role without
- [x] E2E: session variable filter in logical model permissions

### P5.17 — Granular Root Field Visibility (Medium)

Hasura supports `query_root_fields` and `subscription_root_fields` in select permissions to control which root fields a role can access. In neofix, the `player` role uses empty arrays `[]` on bonus/bonus_currency/campaign tables to hide them from direct querying while still allowing access through relationships.

- [x] Parse `query_root_fields` from select permissions in table YAML (array of field names or empty array)
- [x] Parse `subscription_root_fields` from select permissions in table YAML
- [x] Remove `query_root_fields` and `subscription_root_fields` from `UNSUPPORTED_PERMISSION_FIELDS`
- [x] Store in `SelectPermission` type: `queryRootFields?: string[]`, `subscriptionRootFields?: string[]`
- [x] Schema generator: when `queryRootFields` is `[]`, skip generating query root fields (select, selectByPk, selectAggregate) for that role
- [x] Schema generator: when `subscriptionRootFields` is `[]`, skip generating subscription root fields for that role
- [x] When field is undefined/absent, expose all root fields (default Hasura behavior)
- [x] When field is a non-empty array (e.g., `["select", "select_by_pk"]`), only expose listed root fields
- [x] Tables remain accessible through relationships even when root fields are hidden
- [x] Tests: role with `[]` cannot query table directly but can access through parent relationship
- [x] Tests: role with specific fields only sees those root fields
- [x] Tests: role without the field sees all root fields (backwards compatible)

### P5.18 — Role-Aware Documentation Endpoints (Medium) ✅

All three documentation endpoints (`/sdl`, `/openapi.json`, `/llm-api.json`) now filter content based on the requesting role's permissions. Admin gets full docs; other roles see only permitted tables, columns, and operations.

#### Auth on doc endpoints

- [x] Apply auth preHandler to `/sdl`, `/openapi.json`, `/llm-api.json` (extract role from JWT/admin-secret/webhook, fall back to `unauthorizedRole`)
- [x] Admin secret bypasses filtering (returns full schema)

#### `/openapi.json` — role-filtered OpenAPI spec

- [x] Filter `tables` array to only tables the role has at least one permission on
- [x] Filter columns per table to only those in the role's select permission
- [x] Filter CRUD operations: only include GET if select permission exists, POST if insert, PATCH if update, DELETE if delete
- [x] Exclude tables hidden by `query_root_fields: []` for the role
- [x] Pass filtered tables + permission context to `generateOpenAPISpec()`

#### `/llm-api.json` — role-filtered LLM doc

- [x] Same filtering as OpenAPI: tables, columns, operations, relationships visible to the role
- [x] Pass filtered tables + permission context to `generateLLMDoc()`

#### `/sdl` — role-filtered GraphQL SDL

- [x] Generate a filtered GraphQL schema per role (regenerate schema with only permitted tables/columns + `rootFieldTables` option)
- [x] Remove types/fields/root fields the role cannot access
- [x] Cache filtered SDL per role to avoid regenerating on every request

#### Tests (14 tests in `test/role-docs.test.ts`)

- [x] Admin gets full SDL/OpenAPI/LLM doc
- [x] Role with limited permissions sees only permitted tables and columns
- [x] Role with no permissions on a table does not see it in any doc endpoint
- [x] Tables hidden by `query_root_fields: []` are excluded from docs for that role
- [x] Unauthorized role (no auth) sees only tables with anonymous/unauthorized permissions

---

## Unsupported Hasura Feature Validation — COMPLETE

The config loader rejects Hasura metadata features that Hakkyra does not implement. Unsupported files, table fields, database fields, and permission fields produce clear errors during `loadConfig()`. Empty/whitespace-only files are ignored (Hasura CLI creates placeholders).

### Unsupported Top-Level Metadata Files

- [x] `remote_schemas.yaml` / `.yml` — Remote GraphQL schema stitching
- [x] `allowlist.yaml` / `.yml` — GraphQL query allowlisting
- [x] `api_limits.yaml` / `.yml` — Rate limiting, depth limiting, node limiting
- [x] `opentelemetry.yaml` / `.yml` — OpenTelemetry export configuration
- [x] `network.yaml` / `.yml` — TLS certificates, host allowlists
- [x] `backend_configs.yaml` / `.yml` — Backend-specific configuration

### Unsupported Table-Level Fields (By Design)

- [x] `remote_relationships` — Remote joins to external GraphQL/REST sources (by design: single-database architecture)
- [x] `apollo_federation_config` — Apollo Federation entity keys and configuration (by design: standalone API, not a federated subgraph)

### Unsupported Database-Level Fields

- [x] `stored_procedures` — Database stored procedure tracking
- [x] `backend_configs` — Backend-specific configuration overrides
- [x] `customization` — Table name prefix/suffix, root field namespace

### Ignored Permission Fields (warned, not rejected)

- [x] `update_permissions[].permission.validate_input` — Input validation webhook (logged as warning, ignored)

### Tests (34 tests in `test/config-unsupported.test.ts`)

- [x] Each unsupported metadata file triggers a clear error naming the file and unsupported feature
- [x] Each unsupported table field triggers an error naming the table and field
- [x] Each unsupported database field triggers an error naming the database and field
- [x] Each unsupported permission field triggers an error naming the table, role, and field
- [x] Empty/whitespace-only unsupported files do NOT error (Hasura CLI creates empty placeholders)
- [x] Multiple unsupported features in a single load are all reported (not just the first)
- [x] Existing test fixtures with `query_collections.yaml` and `rest_endpoints.yaml` used to verify detection

---

## Phase 6: Test Coverage & Security Hardening

Findings from comprehensive code review of permissions, relationships, computed fields, tracked functions, and security.

### P6.1 — Security Hardening (Critical/High) ✅

- [x] **GraphQL query depth limit** — Mercurius `queryDepth` option, configurable via `graphql.queryDepth` (default: 10)
- [x] **GraphQL max limit** — Configurable `graphql.maxLimit` (default: 100), enforced in resolvers via `graphqlMaxLimit` context
- [x] **Webhook SSRF prevention** — `isPrivateIP()` blocks RFC 1918, loopback, link-local, IPv6 private; DNS resolution check; `webhook.allowPrivateUrls` config (default: false)
- [x] **Webhook response size limits** — Streaming body reader with `webhook.maxResponseBytes` cap (default: 1MB)
- [x] **JWT without `exp` claim** — Reject JWTs missing `exp` in both HTTP and WebSocket auth; `auth.jwt.requireExp` config (default: true)
- [x] **Request body size limit** — Explicit Fastify `bodyLimit` from `server.bodyLimit` config (default: 1MB)

### P6.2 — Permission Test Gaps (High) ✅

49 tests in `test/permission-gaps.test.ts`, 26 tests in `test/rest-permissions.test.ts`:

- [x] **Untested comparison operators** — `_neq`, `_nlike`, `_nilike`, `_similar`, `_nsimilar`, `_regex`, `_nregex`, `_iregex`, `_niregex` (9 tests)
- [x] **Untested JSONB operators** — `_containedIn`, `_hasKeysAny`, `_hasKeysAll` (4 tests)
- [x] **Inherited roles** — SELECT/INSERT/DELETE permission merging tests (union columns, aggregation flag, delete inheritance) (6 tests)
- [x] **Row limit enforcement** — Permission limits enforced at query level (3 tests)
- [x] **Mutation permission checks** — UPDATE post-check (check filter pass/fail), client update with on_hold constraint (7 tests)
- [x] **Subscription permissions** — Basic select permission tested; subscription resolvers now compile full SQL with relationships/computed fields
- [x] **REST permission enforcement** — Column filtering on SELECT/INSERT/UPDATE, insert preset enforcement, row-level filter enforcement, aggregate access control (26 tests in `test/rest-permissions.test.ts`)
- [x] **Negative/denial tests** — Permission denied, 401/403 semantics, forbidden operations (8 tests)
- [x] **Session variable edge cases** — User-scoped queries, custom session vars, combined permission+user filters (5 tests)
- [x] **Nested logical operators** — `_and`+`_or`, empty `_and`/`_or`, `_not`, deeply nested combinations (7 tests)

### P6.3 — Relationship Test Gaps (High) ✅

68 tests in `test/relationship-gaps.test.ts`:

- [x] **Self-referential relationships** — Category table with parent/child hierarchy, object + array relationships (3 tests); fixed missing `localColumns` inference in merger
- [x] **Composite foreign keys** — fiscal_report → fiscal_period via composite FK, manual column_mapping (3 tests); fixed missing `localColumns` inference in merger
- [x] **Relationships in subscriptions** — Subscription resolvers now compile full SQL with relationships via `parseResolveInfo` (4 tests)
- [x] **Relationships in REST responses** — Nested relationships in GraphQL JSON and REST list endpoints (5 tests)
- [x] **WHERE filters on array relationships** — Filter invoices/accounts/appointments by various conditions (6 tests)
- [x] **Relationship limit/offset** — limit, offset, combined, limit:0, large offset (5 tests)
- [x] **Permission enforcement across relationship chains** — Multi-role chain tests, column restriction, session var scoping (7 tests)
- [x] **Multiple FKs to same table** — Transfer table with fromAccount/toAccount resolving to different accounts (2 tests)
- [x] **Null handling in deep chains** — Nullable FK returns null, empty arrays, non-existent PK (5 tests)
- [x] **Circular relationship references** — invoice → client → invoices at multiple nesting levels (3 tests)

### P6.4 — Computed Field Test Gaps (High) ✅

- [x] **Computed fields in WHERE clauses** — Scalar computed fields added to BoolExp input types, SQL WHERE compiler emits function calls, resolver remaps camelCase names (4 schema + E2E tests)
- [x] **Computed fields in ORDER BY** — Scalar computed fields added to OrderBy input types, SQL ORDER BY emits function calls (3 schema + E2E tests)
- [x] **SETOF computed fields** — `client_active_accounts` function, test fixtures + metadata + E2E tests (5 tests)
- [x] **Computed fields in UPDATE/DELETE RETURNING** — Resolvers extract computed fields from parseResolveInfo, pass to update/delete SQL compilers (2 tests)
- [x] **Computed fields with arguments** — Type-builder generates args input types, resolve-info captures args, SQL compiler emits named parameter notation with DEFAULT support (2 tests)
- [x] **Computed fields in subscriptions** — Subscription resolvers use `parseResolveInfo` to extract computed fields and compile them into the SQL query (1 test)
- [x] **Computed fields in aggregations** — Numeric computed fields in SUM/AVG/MIN/MAX/stddev/variance aggregate types, scalar computed fields in GroupByKeys and SelectColumnEnum (schema + E2E tests)
- [x] **Computed fields with session variables** — Session claims injected as JSON parameter via named argument notation in SQL function calls (1 test)
- [x] **Computed fields on views/materialized views** — `client_summary_score` on materialized view with E2E tests (4 tests)

### P6.5 — Tracked Function Test Gaps (Medium) ✅

43 tests in `test/tracked-functions.test.ts` (up from 34):

- [x] **Diverse argument types** — timestamptz and int parameters: `search_clients_by_date`, `search_clients_by_trust` (3 tests)
- [x] **Default parameter values** — `search_clients_by_trust` with DEFAULT max_level=10 (2 tests)
- [x] **Aggregate variants** — SUM/AVG/MIN/MAX on SETOF function results + multi-aggregate (4 tests, bug fix: camelCase JSON keys)
- [x] **Session variable injection** — `my_clients` with session_argument config (2 tests)
- [x] **Custom root field names** — `customRootFields.function` / `customRootFields.functionAggregate` verified with `search_clients_by_date` → `clientsByDate` (4 tests)
- [x] **Inherited role permissions** — backofficeAdmin/support constituent role checks on tracked functions (4 tests)
- [x] **Empty/null results** — SETOF function returning empty set, mutation function with non-existent UUID (2 tests)
- [x] **Mutation functions with relationships in RETURNING** — deactivateClient with nested branch relationship (1 test)
- [x] **Functions in non-public schemas** — Server auto-detects schemas from tracked function configs; `utils.count_active_clients` introspected and queried (5 tests)

### P6.6 — Security Tests (Medium) ✅

28 tests in `test/security.test.ts`:

- [x] **SQL injection via WHERE/ORDER BY** — DROP TABLE, UNION SELECT, DELETE injection, array injection, invalid orderBy (5 tests)
- [x] **JWT algorithm confusion** — `alg:none` rejected via HTTP, REST, and WebSocket; wrong-secret HS256 rejected (3 tests)
- [x] **Webhook header injection** — CRLF injection in header values blocked by Node.js fetch (2 tests)
- [x] **REST ORDER BY column validation** — Invalid column names filtered, SQL injection in column name blocked (3 tests)
- [x] **Computed field argument parameterization** — SQL injection in function args properly parameterized (3 tests)
- [x] **WebSocket auth edge cases** — Empty admin secret, `alg:none`, wrong-secret, garbage token (4 tests)
- [x] **Large array inputs** — 1000 UUIDs, 500+ strings in `_in` operator (3 tests)
- [x] **Tracked function SQL injection** — Injection attempts in function arguments (2 tests)
- [x] **Admin secret timing safety** — Empty admin secret, SQL injection in admin secret header (3 tests)

---

## Phase 7: Code Review Findings (2026-03-16)

Comprehensive review of permissions, relations, computed fields, tracked functions, and security.
Covers all recent commits (e654f3b through 1518030). All 1194 tests passing.

### Bugs Fixed During Review

- **`delivered` column missing from event_log** — `CREATE TABLE IF NOT EXISTS` doesn't add columns to existing tables; added `ADD COLUMN IF NOT EXISTS` migration in `ensureEventSchema`
- **Events test used raw PgBoss instead of PgBossAdapter** — `bossManager.boss` (raw PgBoss) passed to `registerEventWorkers` which calls `work(queue, handler, { concurrency })` with 3 args; raw PgBoss misinterprets the arg order. Switched to `PgBossAdapter`.
- **Zod schema test missing `httpConcurrency` default** — New config field added without updating test expectation

### P7.1 — Security Issues

#### Critical

- [x] **Async action status authorization** — `GET /v1/actions/:actionId/status` now checks `checkActionPermission` against the user's `allowedRoles`. Removed incorrect user_id filtering; actions are shared by role. Admin bypasses. 5 new tests in `test/async-actions.test.ts`, updated tests in `test/security.test.ts`.
- [x] **`backend_only` permission enforced** — `backendOnly` flag checked at runtime in `makeInsertResolver` and `makeInsertOneResolver`; denies non-admin requests. Auth middleware sets `useBackendOnlyPermissions` for admin secret and `x-hasura-use-backend-only-permissions` header. Verification test in `test/security.test.ts`.

#### High

- [x] **GraphQL batching limit** — `graphql.maxBatchSize` config (default: 10) with preHandler enforcement hook. Already implemented.
- [x] **`resolveLimit` unified** — Deduplicated `resolveLimit` into single export from `resolvers.ts`, imported by `subscription-resolvers.ts` and `tracked-functions.ts`. Fixed streaming subscription `batchSize` not being capped by `graphql.maxLimit`. 17 tests in `test/security-limits.test.ts`.

#### Medium

- [x] **DNS rebinding for webhook SSRF** — Removed `validateWebhookUrl()` fallback that allowed unpinned fetches after DNS resolution failure. DNS errors now propagate directly, closing the TOCTOU rebinding window. 4 new tests in `test/security-sanitization.test.ts`.

### P7.2 — Missing Test Coverage: Recent Commits

These recent commits have no regression tests for the specific fix:

- [x] **e654f3b** — Non-set-returning computed fields returning table types: regression test in `test/regression-p72.test.ts`
- [x] **db5e112** — Relationship where filters on tracked functions: regression test in `test/regression-p72.test.ts`
- [x] **eeab354** — FK relationships with custom names: regression test in `test/regression-p72.test.ts`
- [x] **71b10f2** — Table alias in ByPk compilers for computed field permission filters: regression test in `test/regression-p72.test.ts`
- [x] **81da417** — stringify_numeric_types schema types: regression test in `test/regression-p72.test.ts`
- [x] **e8ef889** — Create queue before scheduling cleanup: regression test in `test/regression-p72.test.ts`
- [x] **8a04019** — Concurrency control: regression test in `test/regression-p72.test.ts`

### P7.3 — Permission Test Gaps

- [x] **Root field visibility E2E** — 3 tests verifying `queryRootFields: []` denies root queries while allowing relationship access (`test/permission-gaps-p73.test.ts`)
- [x] **Computed field permission denial** — 5 tests verifying roles without computed fields get null/error (`test/permission-gaps-p73.test.ts`)
- [x] **Update presets via GraphQL** — 3 tests for update presets (`updated_at = now()`), preset override denial, insert presets (`test/permission-gaps-p73.test.ts`)
- [x] **Bulk mutation check constraints** — 2 tests for atomicity: batch rollback on NOT NULL violation (`test/permission-gaps-p73.test.ts`)
- [x] **Delete with permission filter** — 3 tests for `deleteServicePlanByPk` respecting `state = draft` filter (`test/permission-gaps-p73.test.ts`)
- [x] **Upsert permission enforcement** — 2 tests for upsert respecting column presets and update permissions (`test/permission-gaps-p73.test.ts`)
- [x] **Session variable arrays** — 2 tests for `_in` operator with array session variables (`test/permission-gaps-p73.test.ts`)
- [x] **Missing session variable returns null** — 3 tests for absent JWT claims returning zero rows (`test/permission-gaps-p73.test.ts`)
- [x] **Subscription root field visibility** — 2 tests for `subscriptionRootFields: []` denying WebSocket subscriptions (`test/permission-gaps-p73.test.ts`)

### P7.4 — Relationship Test Gaps

- [ ] **Cross-schema relationships** — No cross-schema table fixtures available; `.todo()` in `test/relationship-gaps-p74.test.ts`
- [x] **Nested relationship traversal in where filters** — 4 tests: object-to-object, object-to-array, array-to-nested-object, combined filters (`test/relationship-gaps-p74.test.ts`)
- [x] **Object relationship ordering with NULL FK** — 2 tests for `ASC_NULLS_FIRST` and `ASC_NULLS_LAST` (`test/relationship-gaps-p74.test.ts`)
- [x] **Relationship aggregates as nested query** — Implemented in P8 (see P8 bugs section); `{rel}Aggregate` fields now exposed on object types for array relationships
- [x] **Permissions blocking nested relationship entirely** — 3 tests verifying anonymous role cannot traverse relationships (`test/relationship-gaps-p74.test.ts`)
- [x] **Relationship data in updateMany RETURNING** — 1 test passing; computed fields in updateMany RETURNING not supported (resolver bug, `.todo()`)
- [x] **Config-defined relationship overriding auto-detected** — 2 tests for `primaryAccount` manual relationship coexisting with auto-detected (`test/relationship-gaps-p74.test.ts`)

### P7.5 — Computed Field & Function Test Gaps

- [x] **Aggregate E2E execution of computed fields** — Fixed in P8; `makeSelectAggregateResolver` now passes `computedFields` in both groupBy and non-groupBy paths
- [x] **INSERT RETURNING with computed fields** — 4 tests: single insert, batch insert, backoffice role (`test/computed-function-gaps-p75.test.ts`)
- [x] **SETOF computed field with where/orderBy/limit** — 5 tests exercising all argument combinations on `activeAccounts` (`test/computed-function-gaps-p75.test.ts`)
- [x] **Computed field WHERE with arguments** — Fixed in P8; added all PostgreSQL long-form type aliases (`boolean`, `integer`, etc.) to `PG_TO_GRAPHQL` map
- [x] **Tracked function aggregate with where filter** — 4 tests for `searchClientsAggregate` and `clientsByDateAggregate` with where filters (`test/computed-function-gaps-p75.test.ts`)
- [x] **Tracked function return-table row-level filter** — 6 tests for session-based filtering, column permissions, permission denial (`test/computed-function-gaps-p75.test.ts`)

---

## Phase 8: Code Quality Review (2026-03-16)

Automated review of duplication, typing, security, and architectural coherence across `src/`.

### P8.1 — Security Issues (NEW — not in P7)

#### High

- [x] **Action webhook error reflection** — `sanitizeWebhookError()` in `src/actions/proxy.ts` truncates to 500 chars, strips stack traces/file paths/credential URLs in production mode. 13 tests in `test/security-sanitization.test.ts`.
- [x] **REST error response leaks PG internals** — `sanitizeSQLError()` in `src/rest/router.ts` returns generic message in production mode, full error in dev mode. All 6 catch blocks use it consistently. 13 tests in `test/security-sanitization.test.ts`.

#### Medium

- [x] **URL template path traversal in action transforms** — `interpolateUrlTemplate` now validates path segments after `encodeURIComponent`, rejecting `..` and `.` segments. 13 new tests in `test/action-transforms.test.ts`.
- [x] **Webhook auth cache serves stale roles** — `src/auth/webhook.ts` caches auth results by header hash. If a user's role is revoked on the webhook provider, stale cache entries grant the old role for up to `cacheTtlMs`. This is by-design for performance, but undocumented. Fix: document the trade-off, recommend low TTL values.

### P8.2 — Code Duplication

#### High

- [x] **Session variable resolution duplicated 4×** — Consolidated into `src/auth/session-namespace.ts` (`isSessionVariable`, `resolveSessionVar`). All 4 call sites (`sql/where.ts`, `sql/insert.ts`, `sql/update.ts`, `permissions/compiler.ts`) now use the shared utilities.

#### Medium

- [x] **`quoteIdent()` deduplicated** — All 4 files now import `quoteIdentifier as quoteIdent` from `src/sql/utils.ts`.
- [x] **Worker registration pattern deduplicated** — All three consumers (events, crons, async actions) now use `registerWebhookWorker` from `src/shared/webhook-worker.ts`. Async actions refactored with a custom `deliver` callback for transform support.
- [x] **Trigger lookup deduplicated** — `buildTriggerLookup()` extracted to `src/events/shared.ts`, imported by both `delivery.ts` and `invoke.ts`.
- [x] **Preset resolution duplicated** — Both `resolvePreset()` now use shared `isSessionVariable`/`resolveSessionVar` from `src/auth/session-namespace.ts`.

### P8.3 — TypeScript Typing

#### Medium

- [x] **`as unknown as GraphQLScalarType` pervasive** — `asScalar()` helper already existed for most cases. Added `asInputType()` and `asOutputType()` helpers in `src/schema/scalars.ts` for the 3 remaining casts in `native-queries.ts`.
- [x] **`as any` for decorated Fastify instance** — `src/server/types.ts` defines `MercuriusFastifyInstance`, `HookContext`, `SubscriptionConnectionContext`, `MercuriusExecutionError`, and `asPinoLogger()` helper. All `as any` casts in `src/rest/hasura-endpoints.ts` and `as unknown as Record<string, unknown>` casts in server files replaced with proper types.
- [x] **`createAuthHook` returns `any`** — Already annotated as `FastifyPluginCallback` (line 113).

#### Low

- [x] **`Record<string, any>` in BullMQ adapter** — `src/shared/job-queue/bullmq-adapter.ts:105,163` uses `Record<string, any>` for job options. Justified for optional dependency, but a `BullMQJobOptions` interface would be safer.

### P8.4 — Architecture

#### High

- [x] **Naming utils extracted** — `toCamelCase`, `toSnakeCase`, `toPascalCase` live in `src/shared/naming.ts`. SQL layer imports from `shared/naming.ts`, schema layer re-exports for backward compat.

#### Medium

- [x] **`server.ts` decomposed** — Split from 969 lines into thin orchestrator (362 lines) + 4 modules: `server/context.ts` (buildResolverContext factory), `server/schema.ts` (CJS bridging, introspection control), `server/jobs.ts` (job queue, events, crons, subscriptions), `server/routes.ts` (REST, health, docs).
- [x] **Context building deduplicated** — `buildResolverContext()` factory in `server/context.ts` replaces 3× duplicated inline context objects.
- [x] **Events/crons/actions inconsistent init patterns** — Events return a `Manager` with `stop()`, crons return nothing, actions require two separate calls (`ensureAsyncActionSchema` + `registerAsyncActionWorkers`). Fix: standardize on a `Manager` interface with `init()` and `stop()`.
- [x] **`resolvers.ts` split into modules** — Already split into `resolvers/select.ts`, `resolvers/insert.ts`, `resolvers/update.ts`, `resolvers/delete.ts` with shared `resolvers/helpers.ts`.
- [x] **Error handling inconsistency in webhook workers** — All three consumers (events, crons, async actions) now use the shared `registerWebhookWorker` factory in `src/shared/webhook-worker.ts`, which provides consistent logging (info on success, warn on failure) and throws on failure so pg-boss records error details. Async actions refactored from manual `jobQueue.work()` to the factory with a custom `deliver` callback.

#### Low

- [x] **Tracked functions coupled to resolvers** — `src/schema/tracked-functions.ts:50` imports `remapBoolExp` from `resolvers.ts`. Fix: extract `remapBoolExp` to `src/schema/mapping.ts`.
- [x] **Unused `compileFilter` export** — `src/permissions/index.ts` exports `compileFilter` from `compiler.ts` but it appears unused in the codebase. Verify and remove if dead code.

### Bugs Discovered During Test Gap Coverage

- [x] **`makeSelectAggregateResolver` missing computed fields** — Already fixed; `aggregate.computedFields` is set before both groupBy and non-groupBy paths in `resolvers/select.ts`
- [x] **`makeUpdateManyResolver` missing returning computed fields** — Already fixed; `returningComputedFields` built and passed in `resolvers/update.ts`
- [x] **PG type map missing long-form type names** — Added all PostgreSQL long-form aliases (`boolean`, `integer`, `bigint`, `real`, `double precision`, `character varying`, `timestamp with/without time zone`, etc.) to `PG_TO_GRAPHQL` and `NUMERIC_PG_RETURN` sets
- [x] **No nested aggregate fields on object types** — Array relationships don't expose `{rel}Aggregate` on object types (e.g., `clientByPk { invoicesAggregate { ... } }`)

---

## Phase 9: API Parity (Hakkyra vs Hasura Live Comparison)

Schema introspection comparison of Hakkyra (localhost:8081) vs Hasura (localhost:8080) against the same neofix database. Hakkyra has 2637 object types vs Hasura's 1805. The extra types come from Hakkyra auto-tracking all DB tables instead of only metadata-configured ones.

### P9.1 — Only Expose Metadata-Tracked Tables (Critical) ✅

Hakkyra exposes ALL introspected database tables as GraphQL types with full CRUD, not just tables listed in Hasura metadata. This creates 872 extra types, 63 extra queries, and 212 extra mutations that shouldn't exist.

**Root cause**: `src/introspection/merger.ts` iterates ALL introspected tables and creates `TableInfo` for each. `src/schema/generator.ts` builds types and root fields for everything in `SchemaModel.tables`.

- [x] Merger: only include tables that have a matching entry in metadata YAML config (skip untracked tables)
- [x] Generator: verify that only tracked tables produce object types and root fields
- [x] Keep introspection of all tables for FK/relationship resolution, but mark untracked tables as non-exposed
- [x] Test: tables not in metadata YAML are invisible in the schema

### P9.2 — Preserve Original Relationship Names from Metadata (Critical) ✅

Hakkyra always `toCamelCase()`s relationship names from metadata. Hasura uses the exact `name` field from the YAML. 13 relationships have snake_case names in metadata that Hakkyra incorrectly converts:

| Type | Hasura (YAML `name`) | Hakkyra (converted) |
|------|---------------------|-------------------|
| Authentication | `player_authentication` | `playerAuthentication` |
| BigWin | `game_integration` | `gameIntegration` |
| Country | `payment_provider_countries` | `paymentProviderCountries` |
| CurrentCampaign | `campaign_player` | `campaignPlayer` |
| CurrentCampaignContent | `campaign_player` | `campaignPlayer` |
| Document | `document_source` | `documentSource` |
| Document | `document_status` | `documentStatus` |
| Document | `document_type` | `documentType` |
| GameIntegrationCurrency | `game_integration` | `gameIntegration` |
| PaymentProviderCountry | `payment_provider` | `paymentProvider` |
| PaymentProviderCurrency | `payment_provider` | `paymentProvider` |
| PlayerEventRemoved | `player_event` | `playerEvent` |
| Reward | `player_rewards` | `playerRewards` |

**Root cause**: `src/schema/type-builder.ts:211,245` wraps `rel.name` with `toCamelCase()`.

- [x] Use `rel.name` as-is for the GraphQL field name (Hasura uses the exact YAML name, no conversion)
- [x] Only apply camelCase to auto-detected relationships (from FK inference), not metadata-defined ones
- [x] Update tests that assert camelCase relationship names
- [x] Update `src/schema/resolve-info.ts` to handle snake_case field → snake_case DB mapping

### P9.3 — Enum Table Queryability (High) ✅

Hakkyra's `is_enum: true` handling (P5.13) excludes enum tables from the schema entirely. Hasura keeps multi-column enum tables as queryable types while also using their PK values as enum scalars. 4 tables affected:

- `authentication_method` (1 column: `value`) — Hasura exposes as queryable + enum
- `campaign_event_type` (2 columns: `id`, `description`) — queryable + enum
- `campaign_player_state_type` (2 columns: `id`, `description`) — queryable + enum
- `campaign_state` (2 columns: `id`, `description`) — queryable + enum

This causes 20 missing queries, 28 missing mutations (full CRUD for these 4 tables).

- [x] Change `is_enum` handling: expose enum tables as queryable GraphQL types (with select permissions), in addition to generating enum scalar types from their PK values
- [x] Generate full CRUD for enum tables (same as regular tracked tables)
- [x] Update P5.13 tests to verify enum tables are both queryable and produce enum scalars

### P9.4 — Subscription Aggregate Fields (Medium) ✅

Hakkyra subscriptions only expose `select`, `selectByPk`, and `selectStream`. Hasura also exposes `selectAggregate` subscriptions for every table (157 missing subscription fields).

- [x] Register `{names.selectAggregate}` in `subscriptionFields` in `src/schema/generator.ts`, mirroring the query aggregate field
- [x] Wire subscription-aggregate resolver (re-query on change, same as select subscription but with aggregate SQL)
- [x] Test: subscription to aggregate field receives updates on INSERT/UPDATE/DELETE

### P9.5 — Table-Level `custom_name` Type Naming (Medium) ✅

When a table has `custom_name` in metadata (e.g., `game_session` → `custom_name: gameSession`), Hasura uses the exact custom name as the GraphQL type name (`gameSession`, lowercase start). Hakkyra PascalCases it to `GameSession`.

- [x] When `custom_name` is set on a table, use it verbatim as the GraphQL type name (no PascalCase conversion)
- [x] Apply the same verbatim rule to root field names derived from `custom_name`
- [x] Test: `custom_name: gameSession` produces type `gameSession`, not `GameSession`

### P9.6 — Async Action Result Query Naming (Low) ✅

Hakkyra names async action result queries with a `Result` suffix (`generateTestDataResult`, `updateGamesResult`). Hasura uses the action name directly (`generateTestData`, `updateGames`).

- [x] Remove the `Result` suffix from async action result query root fields
- [x] Use the action name as-is for the result query field name

### P9.7a — Only Expose Config-Defined Relationships ✅

Hakkyra auto-detected relationships from foreign keys and exposed them all in the schema, even when not defined in metadata config. Hasura only exposes relationships that are explicitly tracked. This caused extra relationship fields in BoolExp types, extra SelectColumn enum values, and extra fields on object types.

**Root cause**: `mergeRelationships()` in `src/introspection/merger.ts` included auto-detected relationships that weren't overridden by config.

- [x] Change `mergeRelationships()` to only include config-defined relationships
- [x] Auto-detected FK data still used to fill in missing column mappings for configured relationships
- [x] All existing tests pass (relationships used in tests are all explicitly configured in metadata)

### P9.7b — Remaining Comparison Operator Parity (Medium) — COMPLETE

Schema comparison (hakkyra vs Hasura on neofix DB) found missing comparison operators:

- [x] Add `_gt`, `_gte`, `_lt`, `_lte` to `BooleanComparisonExp` (Hasura has these, hakkyra uses `baseComparisonFields`)
- [x] Add `_gt`, `_gte`, `_lt`, `_lte` to `UuidComparisonExp` (same issue)
- [x] Add `_gt`, `_gte`, `_lt`, `_lte` to `JsonbComparisonExp` (same issue)
- [x] Verify `FloatComparisonExp` is generated when float columns exist

### P9.7c — Nullability Parity (Low)

- [x] Investigate nullability mismatch: `Country.currency` and `Country.language` are nullable in hakkyra but non-null in Hasura — may depend on FK constraint NOT NULL vs nullable
- [x] `BigWin.currency` — nullable in Hasura, non-null in Hakkyra
  - **Resolved**: Object relationship nullability is determined by FK column NOT NULL status. NOT NULL FK → non-null relationship, nullable FK → nullable relationship. Implemented in `type-builder.ts` lines 248-259 with tests in `schema.test.ts`.

### P9.7 — Tracked Function Aggregate Variants for Non-SETOF Functions (Low) ✅

Hasura generates `{function}Aggregate` query variants for all tracked functions including those returning single JSON objects. 6 missing aggregate queries. Low priority since these return `JsonResult` (opaque JSON) where aggregation is meaningless.

- [x] Generate aggregate query fields for all tracked SETOF functions (verify coverage)
- [x] Consider generating aggregate stubs for non-SETOF functions for schema parity — skipped: non-SETOF functions return single rows where aggregation is meaningless; Hasura's stubs for these are non-functional

### P9.8 — Global CRUD Operation Controls ✅

Configurable global defaults for which CRUD operations are exposed, with per-table overrides in metadata YAML. Key distinction: PK-based operations (`updateByPk`, `deleteByPk`) are safe single-row mutations, while non-PK operations (`update`, `delete`, `updateMany`) can affect many rows via WHERE filters — these should be independently controllable.

**Config** (`hakkyra.yaml`):

```yaml
schema:
  default_operations:
    # Reads
    select: true
    select_by_pk: true
    select_aggregate: true
    # Single-row mutations (by PK)
    insert_one: true
    update_by_pk: true
    delete_by_pk: true
    # Bulk/non-PK mutations (WHERE-based, can affect many rows)
    insert: true
    update: false          # e.g., disable non-PK bulk update globally
    update_many: false     # disable updateMany globally
    delete: false          # disable non-PK bulk delete globally
```

Per-table override in table YAML metadata:

```yaml
configuration:
  operations:
    delete: true          # re-enable non-PK delete for this specific table
    update: true          # re-enable non-PK update for this specific table
```

- [x] Add `schema.default_operations` to `hakkyra.yaml` Zod schema (all default `true` for backwards compat)
- [x] Add `configuration.operations` to table YAML Zod schema (optional per-table overrides)
- [x] Schema generator: merge global defaults + per-table overrides, check before registering each root field
- [x] Non-PK mutations (`update`, `delete`, `updateMany`) independently controllable from PK-based ones
- [x] Test: globally disabled non-PK delete hides `deleteCountry` but keeps `deleteCountryByPk`
- [x] Test: per-table override re-enables globally disabled operations
- [x] Test: admin role bypasses operation restrictions (configurable)

### P9.9 — Action Type Parity (High) ✅

Hakkyra maps action output/input types differently than Hasura. Action types defined in `actions.graphql` should use the exact scalar types from the GraphQL definitions.

- [x] Add `ID` scalar type — Hasura uses `ID` for some action output fields (e.g., `AuthenticationInfoResponse.playerToken`); Hakkyra maps them to `String`
- [x] Action input args using `ID!` should remain `ID!`, not become `String!` (`cancelLimit.token`, `triggerTask.token`, `authenticationInfo.token`)
- [x] `AcceptContractWithTokenArgs.contractToken` — Hasura types as `Uuid`, Hakkyra as `String`
- [x] `authenticate.amount` — Hasura types as `numeric` (lowercase scalar), Hakkyra as `String`
- [x] `LatestWinsArgs.cutoff` — Hasura types as `Numeric`, Hakkyra as `String`
- [x] `acceptContractWithToken.args` — Hasura requires `AcceptContractWithTokenArgs!` (non-null), Hakkyra makes it nullable; Hasura also adds `distinctOn`, `limit`, `offset`, `orderBy`, `where` args

### P9.10 — BpcharComparisonExp Operator Types (Medium)

The 10 pattern-matching operators in `BpcharComparisonExp` accept `String` in Hakkyra but `Bpchar` in Hasura. These should use the `Bpchar` scalar for type consistency.

- [x] Change `_like`, `_nlike`, `_ilike`, `_nilike`, `_similar`, `_nsimilar`, `_regex`, `_nregex`, `_iregex`, `_niregex` in `BpcharComparisonExp` to accept `Bpchar` instead of `String`

### P9.11 — `distinctOn` on Subscriptions and Nested Relationship Fields (High)

Hakkyra is missing `distinctOn` arguments on subscription list fields and nested array relationship fields within object types. Also, aggregate queries use `groupBy` instead of Hasura's `distinctOn`.

- [x] Add `distinctOn` argument to subscription list fields (~23 fields)
- [x] Add `distinctOn` argument to nested array relationship fields on object types (e.g., `GameIntegration.currencies`, `GamePresentation.content`, `GamePresentation.games`, `GamePresentation.thumbnails`)
- [x] Replace `groupBy` with `distinctOn` on aggregate query root fields to match Hasura naming

### P9.12 — Aggregate Count Arguments (Medium)

Hasura's `*AggregateFields.count` field accepts `columns` (select column enum) and `distinct` (Boolean) arguments. Hakkyra's aggregate count has no arguments.

- [x] Add `columns: [{Table}SelectColumn!]` argument to `{Table}AggregateFields.count`
- [x] Add `distinct: Boolean` argument to `{Table}AggregateFields.count`
- [x] Affects 7+ aggregate types (all tracked tables with aggregation permissions)
- [x] SQL compiler: emit `COUNT(DISTINCT col1, col2)` when both args provided

### P9.13 — Missing Subscription Fields (Low) ✅

- [x] `latestWins` and `latestWinsAggregate` exist as query fields but not subscription fields — expose tracked function query fields as subscriptions

### P9.14 — Missing Table Fields (Low)

- [x] `AuthenticationProvider.method` — exists in Hasura but not in Hakkyra; investigate whether this is a column visibility or introspection issue
  - **Investigated**: No `authentication_provider` table in test fixtures (production-only). Verified that columns with FK to `is_enum` tables are properly exposed as enum scalar fields (tested with `Appointment.priority` → `PriorityTypeEnum!`). Column visibility logic (`getVisibleColumns`) and enum table resolution (`resolveTableEnums`) both work correctly. Most likely cause: column not included in select permission column lists, or table not tracked in metadata.

### P9.15 — Order-By Type Field Parity (Medium)

Some Hasura order-by aggregate types have different field sets than Hakkyra:

- [x] `GamePresentationContentMaxOrderBy`/`MinOrderBy` — Hasura has `brandId`, `content`, `createdAt`, `description`, `languageId`, `title`, `updatedAt`; Hakkyra only has `id`, `gamePresentationId`
- [x] `GamePresentationThumbnailMaxOrderBy`/`MinOrderBy` — Hasura has `resolution`, `url`; Hakkyra has `gamePresentationId`, `id`
- [x] Root cause: these types should include all orderable (non-array, non-json) columns from the table, not just PK/FK columns

### P9.16 — Schema Column Visibility (High)

Hakkyra exposes ALL database columns on object types for tracked tables. Hasura only exposes columns that appear in at least one role's select permission. This causes extra fields, extra enum values in `SelectColumn`, and extra order-by/bool-exp fields.

Examples:
- `Authentication`: +21 extra fields in Hakkyra
- `BigWin`: +6 extra fields (`createdAtDate`, `gameId`, `gameIntegrationId`, `gameRoundId`, `playerId`, `transactionId`)
- `Currency`: +5 extra fields
- `Game`: +12 extra fields
- `GameIntegration`: +9 extra fields
- `GamePresentation`: +13 extra fields
- `GamePresentationThumbnail`: +6 extra fields

- [x] Schema generator: collect union of all columns across all roles' select permissions for each table
- [x] Only expose columns in the union set on the GraphQL object type (admin still sees all)
- [x] Propagate column filtering to `SelectColumn` enum, `OrderBy` input, `BoolExp` input, `MinFields`/`MaxFields`, etc.
- [x] Tables with no select permissions: only admin can see columns (expose all for admin)
- [x] Test: object type only has columns that appear in at least one role's select permission

---

## Phase 10: API Parity II (Live Schema Comparison 2026-03-16)

Second-round schema introspection comparison of Hakkyra (localhost:8081) vs Hasura (localhost:8080) against the neofix production database. Types: hakkyra=4647 vs hasura=4571. Identifies remaining differences after Phase 9 fixes.

### P10.1 — Views Should Not Have Mutation Methods (Critical) ✅

Hakkyra generates insert/update/delete mutations for views and materialized views. PostgreSQL views cannot be written to (without rules/triggers), so these mutations would fail at runtime. Affects `v_player`, `v_player_daily`, `connected_players`, `game_list_view`, `mv_player_affiliate_contract`, `player_daily_amount_per_type`, `player_daily_amount_per_type_rt`, `player_daily_net_revenue`, `player_event_grouped`, `player_lifetime_net_revenue`, `player_top_games`, `current_exchange_rate`, `authentication_provider`, `json_result`.

**Root cause**: `isOpEnabled()` in `src/schema/generator.ts` only checked `table.operations` config, not `table.isView`.

- [x] `isOpEnabled()` now returns `false` for mutation operations when `table.isView` is `true`
- [x] 2 new tests in `test/schema.test.ts`: materialized view has query fields but no mutation fields

### P10.2 — `updateMany` Return Type Should Be Array (High) ✅

Hasura's `update{Table}Many` mutations return `[{Table}MutationResponse]` (array — one result per update entry). Hakkyra returns `{Table}MutationResponse` (singular). All 95+ `updateMany` mutations are affected.

- [x] Change `updateMany` return type from `MutationResponse` to `[MutationResponse]`
- [x] Update resolver to return array of results
- [x] Test: `updateMany` returns an array

### P10.3 — Action Argument Scalar Types (High) ⚠️ PARTIAL

Hakkyra uses `String` for all action input arguments. Hasura uses the specific scalar types from the action's GraphQL type definitions (`Bigint`, `Numeric`, `Uuid`, `Jsonb`, `Timestamptz`, `PaymentType`, `Json`, `_text`, `Bpchar`). 30 arguments affected.

Examples: `AcceptPlayerContractArgs.playerid` (String→Bigint), `CreatePaymentArgs.amount` (String→Numeric), `ContentEventArgs.parameters` (String→Jsonb), `LatestWinsArgs.cutoff` (String→Numeric).

- [x] Action type parser: resolve scalar types from `actions.graphql` definitions using the project's scalar type map
- [x] Custom scalar types (`numeric`, `Json`, `_text`) should map to their corresponding GraphQL scalars
- [x] SDL-defined enums and PG enum types resolve correctly in action types
- [x] Test: action args use correct scalar types
- [ ] **26 args still use `String`** — see P11.4 for details

### P10.4 — Missing Table Columns (Medium)

~40 tables have columns that Hasura exposes but Hakkyra doesn't. Most are `createdAt`/`updatedAt`/`createdAtDate` timestamps, but some are functional columns. This is likely caused by columns not appearing in any role's select permission (P9.16 column visibility filtering).

Notable missing columns:
- `Affiliate.internal` (Boolean)
- `Authentication.referralToken` (String)
- `BigWin`: `gameId`, `gameIntegrationId`, `gameRoundId`, `playerId`, `transactionId`, `createdAtDate`
- `Brand`: `active`, `defaultJurisdiction`, `createdAt`, `updatedAt`
- `Currency.bigWinThreshold` (Numeric)
- `FunctionSource`: `builtin`, `compiled`
- `FunctionTrigger.functionEventType`
- `Game.raw` (Jsonb)
- `Transaction`: `extra`, `gameId`, `gameIntegrationId`
- `PlayerEvent`: `functionId`, `groupKey`
- `PlayerData.token`

- [ ] Investigate: are these columns missing from select permissions in the neofix metadata, or is there a bug in column visibility?
- [ ] If metadata issue: update neofix metadata to include missing columns in select permissions
- [ ] If code issue: fix column visibility logic

### P10.5 — Constraint Enum Values for Upserts (High) ✅

120 `*Constraint` enums are empty — missing their actual constraint names (e.g., `AffiliateConstraint` should have `affiliateExternalIdKey`, `affiliatePkey`). These values are needed for `on_conflict` upsert operations.

- [x] Introspect real PK constraint names from PG catalog (not fabricated)
- [x] Include both PK and unique constraint names in enums
- [x] Use Hasura's camelCase naming convention for enum values
- [x] Test: constraint enums contain correct constraint names

### P10.6 — Missing Subscription Fields (Medium) ✅

11 subscription fields present in Hasura but missing from Hakkyra:
- `counterProgressAverageBet`, `counterProgressRtp` — computed field subscriptions
- `generateTestData`, `updateGames` — async action result subscriptions
- `playersWithMatchingData` — tracked function subscription
- 6 `*Aggregate` subscriptions for tracked functions (`gameSessionTransactionCountAggregate`, `getGameSessionSummaryAggregate`, `getMarketingContractsAggregate`, `getPlayerMonthlySummaryAggregate`, `getTournamentLeaderboardAggregate`, `getTournamentLeaderboardCountAggregate`)

- [x] Expose tracked function aggregate variants as subscription fields
- [x] Expose async action result queries as subscription fields
- [x] Test: tracked function aggregates available as subscriptions

### P10.7 — Nullability Mismatches (Low) ⚠️ REGRESSION

14 relationship fields have different nullability between Hakkyra and Hasura. Hakkyra marks some as non-null (`!`) where Hasura allows null.

Affected: `Balance.player`, `BigWin.currency`, `CurrentCampaignContent.campaignPlayer`, `Game.brands`, `Player.data`, `PlayerBonus.bonus`, `PlayerEvent.player`, `PlayerLimit.currentCounter`, `PlayerReward.player`, `TransactionSummary.currency`/`.game`/`.payment`, `Wallet.balance`/`.paymentMethod`.

- [x] Array relationships changed from `[Type!]!` to `[Type!]` (nullable list)
- [x] Object relationship nullability based on FK column NOT NULL status (already implemented in P9.7c)
- [x] `Player.data` and `Game.brands` are array relationships — now nullable `[Type!]`
- [ ] **WRONG DIRECTION**: Hasura array relationships are `[Type!]!` (non-null list), not `[Type!]` — see P11.2
- [ ] **11 object relationship nullability mismatches remain** — see P11.3

### P10.8 — `Player.lock` Cardinality (Medium) ⚠️ STILL BROKEN

Hakkyra: `Player.lock: [PlayerLock!]!` (array relationship). Hasura: `Player.lock: PlayerLock` (object relationship). The metadata likely defines `lock` as an object relationship, but Hakkyra may be interpreting it as an array.

- [x] Fixed reverse-FK object relationship column mapping in config loader
- [x] Extended merger to infer localColumns for all relationship types with remoteColumns
- [ ] **Still array**: SDL shows `Player.lock(...): [PlayerLock!]` with array args — still not an object relationship

### P10.9 — Enum Comparison Operators `_gt`/`_gte`/`_lt`/`_lte` (Low) ✅

17 enum comparison types are missing `_gt`, `_gte`, `_lt`, `_lte` operators that Hasura provides. These are ordering operators on enum types.

Affected: `AffiliateCommissionBaseComparisonExp`, `AffiliateCommissionTypeComparisonExp`, `ContentChannelSourceComparisonExp`, `CounterTypeComparisonExp`, `FunctionStatusComparisonExp`, `FunctionTriggerTypeComparisonExp`, `PaymentApprovalTypeComparisonExp`, and 10 more.

- [x] Add `_gt`, `_gte`, `_lt`, `_lte` operators to all PG enum comparison types
- [x] SQL compiler: emit `> $N`, `>= $N`, `< $N`, `<= $N` for enum ordering (already generic)
- [x] 25 tests: schema verification + E2E ordering on enum columns

### P10.10 — Array Fields in Aggregate Min/Max Types (Low) ✅

Hakkyra returns `String` for array columns (e.g., `tags`, `currencies`) in `MaxFields`/`MinFields` aggregate types. Hasura returns `[String!]`.

- [x] Aggregate type builder: use array type `[ScalarType!]` for array columns in min/max fields
- [x] Test: aggregate min/max on array columns returns array type

### P10.11 — Aggregate Stat Return Types (Low) ⚠️ PARTIAL

Hakkyra uses `Float` for all aggregate stat fields (avg, stddev, variance, etc.). Hasura uses `Numeric` for `numeric`/`bigint` columns and `Int` for `integer`/`smallint` columns. 44 occurrences.

- [x] Aggregate stat type builder: use `Numeric` return type for `numeric`/`bigint` source columns
- [x] Use `Int` return type for `integer`/`smallint` source columns in sum fields
- [x] Test: aggregate stat fields use correct return types
- [ ] **Incomplete**: `avg`/`stddev`/`variance` fields on `int`/`bigint` columns return `Numeric`, but Hasura returns `Float` — see P11.1

### P10.12 — `Timestamp` vs `Timestamptz` (Low) ✅

`CampaignContentQueue.checkpoint`/`.deliverAt` and `CampaignPlayerPayment.createdAt` use `Timestamptz` in Hakkyra but `Timestamp` (without timezone) in Hasura. This is a PG column type issue — the columns are likely `timestamp without time zone`.

- [x] Add `Timestamp` scalar type for `timestamp without time zone` columns (separate from `Timestamptz`)
- [x] Generate `TimestampComparisonExp` for timestamp-without-tz columns

### P10.13 — `Transaction.sequence` Smallint Scalar (Low) ✅

`Transaction.sequence` uses `Int` in Hakkyra but `Smallint` in Hasura. The PG column is `smallint`.

- [x] Add `Smallint` scalar type with `SmallintComparisonExp`
- [x] Map `smallint`/`int2` → `Smallint` in PG type map

### P10.14 — Hasura-Only Input Types (Low)

Hasura generates ~545 input types that Hakkyra doesn't: `*IncInput` (increment), `*Updates` (multi-column update), `*ObjRelInsertInput`/`*ArrRelInsertInput` (nested insert relationship wrappers), `*AppendInput`/`*PrependInput`/`*DeleteAtPathInput`/`*DeleteElemInput`/`*DeleteKeyInput` (JSONB mutation operators).

Hakkyra uses simpler `InsertInput` types (not `ObjRelInsertInput`), and doesn't support JSONB mutation operators or `_inc` yet.

- [ ] **JSONB mutation operators**: `_append`, `_prepend`, `_deleteAtPath`, `_deleteElem`, `_deleteKey` for JSONB columns in update mutations
- [ ] **`_inc` operator**: numeric increment operator for update mutations
- [ ] **Nested insert input wrapper types**: `ObjRelInsertInput`/`ArrRelInsertInput` for relationship-aware nested inserts
- [ ] **`*Updates` input type**: Hasura's batch update input type (alternative to Hakkyra's `updateMany`)

### P10.15 — `updateGameSessionMany` Casing (Low) ✅

Hakkyra generates `updategameSessionMany` (lowercase `g`). Hasura generates `updateGameSessionMany` (capital `G`). This is because `gameSession` is a `custom_name` and the `updateMany` name builder doesn't handle verbatim custom names correctly.

- [x] Fix: capitalize first letter of `typeName` after verb prefixes for all 7 prefixed root fields
- [x] Same fix applied to insert*, update*, delete* prefixed names

### P10.16 — Async Action Query/Subscription Return Types (Low) ⚠️ PARTIAL

Hakkyra returns `AsyncActionId!` for async mutation results and `GenerateTestDataAsyncResult`/`UpdateGamesAsyncResult` for result queries. Hasura returns `uuid!` for mutations and uses the action name directly for result queries/subscriptions (e.g., `generateTestData`, `updateGames`).

- [x] Mutation return: use `uuid!` scalar instead of custom `AsyncActionId` type
- [x] Result query return: use action handler return type, not custom `*AsyncResult` wrapper
- [ ] **Scalar case**: Mutation returns `Uuid!` but Hasura returns `uuid!` (lowercase) — see P11.9
- [ ] **Result type names**: Query returns `OkResult` but Hasura returns types named after the action (`generateTestData`, `updateGames`) — see P11.9

### P10.17 — `playerDataReport`/`playerProfile` Return Types (Low) ✅

Hakkyra returns `String` for `playerDataReport` and `playerProfile` tracked functions. Hasura returns `jsonb!`. These functions return JSONB but Hakkyra may be treating them as text.

- [x] Tracked functions returning `jsonb` now expose `Jsonb!` scalar (not skipped)
- [x] Tracked functions returning `json` now expose `json!` scalar
- [x] Added scalar function resolver for non-table-returning tracked functions

### P10.18 — Hasura-Only `AggregateBoolExp` Bool Column Enums (Low)

Hasura generates `*SelectColumn*AggregateBoolExpBool_andArgumentsColumns` and `*Bool_orArgumentsColumns` enums for aggregate boolean expressions. These are used for typed `bool_and`/`bool_or` aggregate filtering. 47 missing enums.

- [ ] Generate `AggregateBoolExpBool_and` and `AggregateBoolExpBool_or` types with column-specific enum arguments
- [ ] Only needed for tables with boolean columns used in aggregate bool expressions

---

## Phase 11: API Parity III (Live SDL Comparison 2026-03-16)

Third-round schema comparison of Hakkyra SDL (localhost:8081/sdl) vs Hasura introspection (localhost:8080) against the neofix database. Types: hakkyra ~2,140 object/input types vs hasura ~4,571. Identifies regressions from P10 fixes and new gaps.

### P11.1 — Aggregate Avg/Stddev/Variance Return `Numeric` Instead of `Float` (High) ✅

P10.11 fixed `sum` field types but `avg`, `stddev`, `stddevPop`, `stddevSamp`, `variance`, `varPop`, `varSamp` fields on `int`/`bigint` columns still return `Numeric`. Hasura returns `Float` for these statistical functions regardless of source column type (only `sum` uses source-dependent types).

**Rule**: `avg`/`stddev*`/`var*` → always `Float`. Only `sum` uses source-dependent return types.

- [x] Simplified `resolveStatAggReturnType()` in `inputs.ts` to always return `GraphQLFloat`
- [x] Updated 6 tests expecting `Numeric` to expect `Float`

### P11.2 — Array Relationship Nullability Reversed (High) ✅

P10.7 changed array relationships from `[Type!]!` to `[Type!]` (nullable list). But Hasura uses `[Type!]!` (non-null list). The fix went the wrong direction. 55 array relationship fields affected.

- [x] Wrapped outer list in `GraphQLNonNull` in `type-builder.ts:305` → `[Type!]!`
- [x] Updated 2 tests to expect non-null list

### P11.3 — Object Relationship Nullability Mismatches (Medium) ✅

11 object relationships have wrong nullability. Root cause: reverse-FK and manual_configuration relationships were using local PK column nullability (always NOT NULL) instead of being unconditionally nullable.

- [x] Systemic fix in `type-builder.ts`: only forward-FK relationships (with real FK constraint on local table) use column nullability; reverse-FK and manual_configuration relationships are always nullable
- [x] Also fixed P10.8 `Player.lock`: added dedup in `loader.ts` — object relationships take precedence over array relationships with same name

### P11.4 — Action Arg Types Still `String` (High) ✅

P10.3 resolved some but 26 action arguments still use `String` instead of proper scalar types:

| Arg | Hakkyra | Hasura |
|---|---|---|
| `AcceptContractWithTokenArgs.contractToken` | `String` | `Uuid` |
| `AcceptPlayerContractArgs.playerid` | `String` | `Bigint` |
| `BackofficeSetContractArgs.playerid` | `String` | `Bigint` |
| `CompleteCounterProgressArgs.counterProgressId` | `String` | `Bigint` |
| `ContentEventArgs.parameters` | `String` | `Jsonb` |
| `CreatePaymentArgs.amount` | `String` | `Numeric` |
| `CreatePaymentArgs.paymentType` | `String` | `PaymentType` |
| `CreatePaymentArgs.playerId` | `String` | `Bigint` |
| `CreatePlayerRiskArgs.parameters` | `String` | `Json` |
| `CreateTaskArgs.parameters` | `String` | `Json` |
| `FnRewardJackpotArgs.pIncrease` | `String` | `Numeric` |
| `FnRewardJackpotArgs.pInitialValue` | `String` | `Numeric` |
| `FnRewardJackpotArgs.pMinimumJackpot` | `String` | `Numeric` |
| `GetCounterProgressArgs.playerid` | `String` | `Bigint` |
| `GetGameSessionSummaryArgs.gamesessionid` | `String` | `Bigint` |
| `GetGameSessionSummaryArgs.playerid` | `String` | `Bigint` |
| `LatestWinsArgs.cutoff` | `String` | `Numeric` |
| `LockPlayerArgs.playerid` | `String` | `Bigint` |
| `RemoveArgs.playerid` | `String` | `Bigint` |
| `StealArgs.playerid` | `String` | `Bigint` |
| `TriggerContentDeliveryArgs.brandid` | `String` | `Bpchar` |
| `TriggerContentDeliveryArgs.params` | `String` | `Jsonb` |

**Root cause**: These are tracked function args, not action SDL args. `PG_ARG_TYPE_MAP` in `tracked-functions.ts` had wrong scalar name keys (e.g., `'BigInt'` vs `'Bigint'`, `'UUID'` vs `'Uuid'`).

- [x] Fixed 8 wrong scalar name mappings in `PG_ARG_TYPE_MAP`
- [x] Added enum type resolution to `pgArgTypeToGraphQL()` (for types like `PaymentType`)
- [x] Added 6 test cases verifying scalar arg type resolution

### P11.5 — Nested Aggregate Fields Missing Args (Medium) ✅

All nested `*Aggregate` fields on object types were missing `distinctOn`, `limit`, `offset`, `orderBy` arguments.

- [x] Added all 4 args to aggregate relationship fields in `type-builder.ts`
- [x] Added test verifying args on aggregate relationship fields

### P11.6 — Tracked Function Args Should Be Non-Null (Medium) ✅

Hakkyra makes tracked function `args` parameters nullable. Hasura makes them non-null.

- [x] Wrapped `args` in `GraphQLNonNull` in `tracked-functions.ts` (main + aggregate variant)
- [x] Updated tests to verify `args` is required

### P11.7 — Tracked Function Return Type Mismatches (High) ✅

Several tracked functions return `String!` because `pgTypeToGraphQL` falls back to `String` for unknown types (untracked tables).

- [x] Added `isKnownPgScalarType()` in `type-map.ts` to distinguish real scalars from untracked table types
- [x] Functions returning untracked tables now skip with warning instead of falling back to `String!`
- [x] The 5 affected functions will auto-expose once P11.13 tables are tracked

### P11.8 — Native Query / Computed Field Args Structure (Medium) ✅

Native queries used inline args. Hasura wraps them in `*_arguments` input type with standard query args.

- [x] Wrapped native query params in `*_arguments` input types in `native-queries.ts`
- [x] Added `where`, `orderBy`, `limit`, `offset`, `distinctOn` args
- [x] Generated `BoolExp`, `OrderBy`, `SelectColumn` types for logical models
- [x] Updated resolver to extract args from wrapper object

### P11.9 — Async Action Scalar Case and Result Type Names (Low) ✅

- [x] Added lowercase `uuid` scalar in `scalars.ts`, changed async action mutations/queries/subscriptions to use `uuid` instead of `Uuid` in `actions/schema.ts`
- [x] Result queries already use the action's output type (not `OkResult`) — was fixed by P10.16

### P11.10 — PG Enum Types: Enum vs Scalar (Low)

15 PG enum types are exposed as GraphQL `enum` in Hakkyra but as `scalar` in Hasura. Hasura treats PG enums as opaque scalars with `*ComparisonExp` for filtering.

Affected: `AffiliateCommissionBase`, `AffiliateCommissionType`, `ContentChannelSource`, `CounterType`, `FunctionStatus`, `FunctionTriggerType`, `PaymentApprovalType`, `PaymentState`, `PaymentType`, `PlayerBonusStatus`, `RewardStatus`, `RewardType`, `TaskStatus`, `TaskTriggerFrequency`, `WalletStatus`.

Hakkyra's approach (real GraphQL enums with values) is arguably better for type safety. This may be intentional divergence.

- [ ] Decide: keep as enums (better DX) or match Hasura's scalar approach (strict compat)?

### P11.11 — Computed Field BoolExp Type Mismatch (Low) ✅

Computed fields returning tracked table types (SETOF) were not included in BoolExp filters, causing column-level filters to take precedence.

- [x] Added computed field BoolExp handling in `filters.ts` — SETOF computed fields returning tracked tables now use the table's BoolExp
- [x] Added 2 tests verifying computed field relationship filters

### P11.12 — `authenticate(amount)` Scalar Case (Low)

- Hakkyra: `amount: Numeric` (PascalCase)
- Hasura: `amount: numeric` (lowercase)

Hasura uses lowercase `numeric` scalar for some action args.

- [ ] Investigate if this is a general issue with action arg scalar casing or specific to `authenticate`

### P11.13 — 50 Missing Table Types (Critical — Investigation)

50 table types present in Hasura are completely missing from Hakkyra's schema. This accounts for ~960 missing types (object types, input types, enums, mutation responses, stream cursors, etc.) and ~1,130 missing root fields.

Missing tables: `AuthenticationMethodProvider`, `BrandAuthenticationProvider`, `BrandCurrency`, `CampaignContentQueue`, `CampaignEventType`, `CampaignPlayerPayment`, `CampaignPlayerStateType`, `CampaignRewardTriggerType`, `CampaignSelectionType`, `CampaignState`, `ContentType`, `ExchangeRate`, `GameIntegrationBrand`, `GameProfile`, `GameProviderReference`, `GameSessionSummary`, `Jurisdiction`, `KycLevel`, `PlayerAuthentication`, `PlayerAuthenticationFactor`, `PlayerBonus`, `PlayerCoinBalance`, `PlayerDailyAmountPerType`, `PlayerDailyAmountPerTypeRt`, `PlayerDailyNetRevenue`, `PlayerEventGrouped`, `PlayerEventRemoved`, `PlayerLimitCounter`, `PlayerQuestionnaire`, `PlayerQuestionnaireFile`, `PlayerRisk`, `PlayerTask`, `PlayerTopGames`, `Promotion`, `Questionnaire`, `Risk`, `RiskCategory`, `Role`, `Setting`, `Task`, `TaskType`, `TempFile`, `TinyUrl`, `TransactionSummary`, `TransactionWithGameRound`, `UserEvent`, `VPlayer`, `VPlayerDaily`, `WageringRequirementResult`, `gameSession`.

**Investigation result (updated 2026-03-16)**: Previous conclusion of "DB mismatch" was WRONG. Both services connect to the same DB (`postgresql://...@localhost:5432/neofix`), all 50 tables and all columns exist. Re-verified via direct DB queries and introspection debug logging.

All 50 tables now appear in hakkyra's schema (confirmed via introspection query — 461 query root fields vs Hasura's 467, the 6 difference being tracked function aggregate variants per P12.6).

- [x] Investigate: all 50 tables confirmed present in both DB and hakkyra schema
- [x] Re-run comparison: tables are present, remaining differences are column-level (see P12.11)

### P11.14 — `groupedAggregates` Extension (Low)

Hakkyra exposes `groupedAggregates` fields on all `*Aggregate` types (~61 fields). Hasura does not have this. This is a Hakkyra-only extension.

Not a bug — but for strict SDL compatibility, consider making this opt-in or removing it.

- [ ] Decide: keep as extension (document divergence) or make configurable?

---

## Phase 12: API Parity IV (Live Introspection Comparison 2026-03-16)

Fourth-round comparison using full introspection queries against both services on the same neofix DB (`localhost:5432/neofix`). Admin-level comparison plus **backoffice role** comparison (eliminates admin-only column noise).

**Admin comparison**: 590 types only in Hasura, 621 only in Hakkyra, 56 field type mismatches, 796 input field diffs.

**Backoffice role comparison** (cleaner — shows real client-facing gaps):
- 188 types only in Hasura: IncInput, Updates, ObjRel/ArrRelInsertInput, JSONB mutation inputs, AggregateBoolExp bool_and/bool_or, AggregateOrderBy.
- 1 missing query root field (`getGameSessionSummaryAggregate`), 0 missing mutation root fields.
- 33 field type mismatches: 10 relationship nullability, 23 aggregate stat types (Numeric vs Float).
- 54 fields missing: enum/UUID columns in Max/Min fields, aggregate relationship fields.
- 78 input fields missing: AggregateBoolExp bool_and/bool_or, enum columns in Max/MinOrderBy, tracked function args, InetComparisonExp ops.
- 627 input fields extra in hakkyra: admin-only columns in InsertInput/SetInput, boolean columns in Max/MinOrderBy, enum comparison _gt/_lt/_gte/_lte.
- 196 arg diffs: missing _inc/_append/_prepend/_deleteAtPath/_deleteElem/_deleteKey on updates, _set nullability (Hasura nullable, hakkyra non-null), updateMany type name, tracked function mutation missing query args.

**Player role comparison** (tightest — minimal permissions):
- 32 types only in Hasura: Updates (5), JSONB mutation inputs (5), AggregateBoolExp (2), AggregateOrderBy (12), scalars (2), misc (6).
- 0 missing root fields (query, mutation, subscription all match).
- 23 field type mismatches: 8 relationship nullability, 14 ReferralLink aggregate stat Int vs Float, 1 Wallet nullability.
- 17 fields missing: enum/UUID in Max/Min fields, `Reward.playerRewardsAggregate`, `WithdrawalWallet.wallet`, `AuthenticationProvider.method`.
- 23 input fields missing: AggregateBoolExp bool_and/bool_or, enum columns in Max/MinOrderBy, AggregateOrderBy refs.
- 1492 input fields extra in hakkyra: admin-only columns leaking into BoolExp/OrderBy/StreamCursor/InsertInput/SetInput.
- 90 arg diffs: tracked function query args missing, `args` nullability, JSONB update ops, `_set` nullability, `numeric` scalar casing, updateMany type name.

**Note**: Hakkyra does NOT scope GraphQL introspection by role — always returns full schema. SDL/OpenAPI/LLM-doc endpoints now respect `x-hasura-role` header with admin key (fixed this session). Hasura scopes all endpoints by role.

### P12.1 — Missing Mutation Input Infrastructure: ObjRelInsertInput / ArrRelInsertInput (Critical)

Hasura wraps nested relationship inserts in `*ObjRelInsertInput` (64 types) and `*ArrRelInsertInput` (48 types) wrapper types containing `data` + `onConflict` fields. Hakkyra uses direct type references (e.g., `PlayerInsertInput` instead of `PlayerObjRelInsertInput`).

This causes 112 types to be missing and ~200 input field type mismatches (every InsertInput field referencing a relationship uses the wrong type).

- [ ] Generate `*ObjRelInsertInput` types for each object relationship on insert-enabled tables (fields: `data: *InsertInput!`, `onConflict: *OnConflict`)
- [ ] Generate `*ArrRelInsertInput` types for each array relationship on insert-enabled tables (fields: `data: [*InsertInput!]!`, `onConflict: *OnConflict`)
- [ ] Update InsertInput relationship fields to reference wrapper types instead of direct types

### P12.2 — Missing Mutation Input Infrastructure: IncInput (Critical) ✅

Hasura generates 103 `*IncInput` types for numeric column increments during updates. Hakkyra has 0.

- [x] Generate `*IncInput` types for each table with numeric columns (int, bigint, numeric, float)
- [x] Wire into update mutations (update, update_by_pk, update_many)
- [x] SQL compiler: `column = column + $N` for increment, `_set` takes precedence on collision
- [x] 16 tests (schema, SQL compilation, E2E)

### P12.3 — Missing Mutation Input Infrastructure: Updates (Critical)

Hasura generates 127 `*Updates` types — batch update input types with `_set`, `_inc`, `where` fields. Used by `update_*_many` mutations. Hakkyra has 0.

- [ ] Generate `*Updates` types for each table with update permissions
- [ ] Wire into `update_*_many` mutations

### P12.4 — Missing JSONB Mutation Operators (High)

Hasura generates 135 JSONB mutation input types for tables with jsonb columns: `*AppendInput` (27), `*PrependInput` (27), `*DeleteAtPathInput` (27), `*DeleteElemInput` (27), `*DeleteKeyInput` (27). Hakkyra has 0.

These allow jsonb-specific update operations (append to array, prepend, delete at path, delete element by index, delete key).

- [ ] Generate `*AppendInput` types (fields: each jsonb column → `Jsonb`)
- [ ] Generate `*PrependInput` types (same structure)
- [ ] Generate `*DeleteAtPathInput` types (fields: each jsonb column → `[String!]`)
- [ ] Generate `*DeleteElemInput` types (fields: each jsonb column → `Int`)
- [ ] Generate `*DeleteKeyInput` types (fields: each jsonb column → `String`)
- [ ] Wire into update mutations (`_append`, `_prepend`, `_deleteAtPath`, `_deleteElem`, `_deleteKey` args)

### P12.5 — Missing AggregateBoolExp Types (High)

Hasura has 176 `AggregateBoolExp` types, Hakkyra has 96. The missing 80 types are `bool_and`/`bool_or` aggregate boolean expressions and their associated `SelectColumn*AggregateBoolExp*` enum types. These allow filtering parent rows based on boolean aggregate conditions on array relationships (e.g., "campaigns where ALL rewards are active").

- [ ] Generate `*AggregateBoolExpBool_and` / `*AggregateBoolExpBool_or` input types for each array relationship with boolean columns
- [ ] Generate associated `*SelectColumn*AggregateBoolExpBool_and/orArgumentsColumns` enum types
- [ ] Add `bool_and` / `bool_or` fields to existing `*AggregateBoolExp` types

### P12.6 — Tracked Function Aggregate Root Fields Missing (High)

6 tracked functions are missing `*Aggregate` query root fields and their subscription equivalents. These are functions that return SETOF rows and should have aggregate variants.

Missing query root fields:
- `gameSessionTransactionCountAggregate`
- `getGameSessionSummaryAggregate`
- `getMarketingContractsAggregate`
- `getPlayerMonthlySummaryAggregate`
- `getTournamentLeaderboardAggregate`
- `getTournamentLeaderboardCountAggregate`

- [ ] Generate aggregate root fields for tracked functions returning SETOF table types
- [ ] Add matching subscription root fields

### P12.7 — Missing Subscription Root Fields (Medium)

3 subscription root fields present in Hasura are missing in Hakkyra (beyond the 6 tracked function aggregates in P12.6):

- `counterProgressAverageBet → [CounterProgressAverageBetResult!]!`
- `counterProgressRtp → [CounterProgressRtp!]!`
- `playersWithMatchingData → [PlayersWithMatchingData!]!`

These appear to be native queries or tracked functions exposed as subscriptions. Their associated types (BoolExp, SelectColumn, OrderBy, StreamCursor) also need generation.

- [ ] Investigate source of these 3 subscription fields (native queries? tracked functions?)
- [ ] Generate types and root fields to match

### P12.8 — Tracked Function Arg Naming Convention (Medium) ✅

Hasura uses underscore-prefixed args for tracked function parameters: `_key`, `_externalId`, `_initialAmount`, `_code`, `_properties`, `_uniqKey`, `_channel`, `_destination`, `_parameters`, `_targetAmount`. Hakkyra uses PascalCase: `Key`, `ExternalId`, `InitialAmount`, `Code`, `Properties`, `UniqKey`, `Channel`, `Destination`, `Parameters`, `TargetAmount`.

Affected functions: `fnInsertReward`, `fnPlayerStartCounter`, `fnTriggerCampaign`, `fnTriggerContent`.

- [x] Use raw PG parameter names directly in args input types (no camelCase conversion)
- [x] Updated resolver to read args by raw PG name
- [x] 9 new tests

### P12.9 — Object Relationship Nullability Regression (Medium)

12 object relationship fields are `NON_NULL` in Hakkyra but nullable in Hasura. These appear to be reverse-FK or manual relationships that should be nullable per P11.3 rules, but the fix didn't catch all cases.

Affected: `Balance.player`, `BigWin.currency`, `CurrentCampaignContent.campaignPlayer`, `Game.brands` (array!), `Player.data` (array!), `PlayerBonus.bonus`, `PlayerEvent.player`, `PlayerLimit.currentCounter` (array!), `PlayerReward.player`, `TransactionSummary.currency/game/payment`, `Wallet.balance/paymentMethod`.

- [ ] Audit each field — some are array relationships (`Game.brands`, `Player.data`, `PlayerLimit.currentCounter`) that should have nullable list items? Or non-null lists?
- [ ] Fix nullability to match Hasura exactly

### P12.10 — Aggregate Stat Return Type: `Numeric` Source Columns Return `Float` (Medium) ✅

P11.1 changed ALL avg/stddev/variance fields to return `Float`. This is wrong for `numeric` source columns — Hasura returns `Numeric` for those.

**Hasura's actual rule**: `numeric` source → `Numeric` for avg/stddev/variance. `int`/`bigint` source → `Float`. Hakkyra currently returns `Float` for everything.

Affected (confirmed from backoffice comparison): `BalanceAvgFields.{nativeTotal,total}`, `BalanceStddevFields.{nativeTotal,total}`, `BalanceVarianceFields.{nativeTotal,total}`, `PlayerRewardAvgFields.outcome`, `PlayerRewardStddevFields.outcome`, `PlayerRewardVarianceFields.outcome`. All are computed fields returning `numeric`.

(The ReferralLink integer fields from admin comparison are admin-only and don't show in backoffice — those use `Float` correctly.)

- [x] Fix `resolveStatAggReturnType()`: return `Numeric` for `numeric` source type, `Float` for `int`/`bigint`
- [x] Updated 6 test assertions

### P12.11 — Admin-Only Columns Not Exposed in Schema (Design Decision)

413 fields missing in Hakkyra across many tables. **Root cause found**: NOT a DB mismatch. Both services connect to the same DB (`localhost:5432/neofix`). All columns verified present via direct DB query and introspection debug logging (all 12 `big_win` columns introspected correctly).

The real cause is `getVisibleColumns()` in `type-builder.ts:81-103`: it unions columns from all role select permissions to determine schema visibility. Columns not listed in ANY role's select permission are excluded from the GraphQL schema. Hasura's admin role always sees ALL columns regardless of select permission config.

Example: `big_win` has `anonymous` and `player` permissions listing only `{amount, brand_id, created_at, currency_id, id, multiplier}`. The FK columns (`player_id`, `game_id`, `game_round_id`, `transaction_id`, `game_integration_id`) and `created_at_date` are admin-only — no role lists them. Hakkyra excludes them; Hasura includes them for admin.

Affected: `Affiliate.internal`, `Authentication.referralToken`, `Balance.createdAtDate`, `BigWin.{createdAtDate,gameId,gameIntegrationId,gameRoundId,playerId,transactionId}`, `Brand.{active,createdAt,defaultJurisdiction,updatedAt}`, `BrandLanguage.{active,createdAt,updatedAt}`, `Campaign.createdAtDate`, `CampaignContent.active`, `CampaignPlayer.instanceId`, plus many more timestamp/audit/FK columns across ~50 tables.

All corresponding BoolExp, OrderBy, StreamCursorValueInput, SelectColumn, Constraint enum values, and aggregate fields are also missing.

**Decision**: Hakkyra's approach (schema only shows columns accessible to at least one role) is arguably better — it keeps the schema clean and doesn't leak admin-only column names. For Hasura compat, could add an option to expose all columns.

- [ ] Decide: keep current behavior (cleaner schema) or add `expose_all_columns: true` config option for Hasura compat?
- [ ] If keeping current behavior, document this as intentional divergence

### P12.12 — Enum Comparison Exp Extra Operators (Low) ✅

Hakkyra adds `_gt`, `_lt`, `_gte`, `_lte` operators on enum comparison expressions (e.g., `AuthenticationMethodEnumComparisonExp`, `CampaignEventTypeEnumComparisonExp`, `CampaignPlayerStateTypeEnumComparisonExp`, `CampaignStateEnumComparisonExp`). Hasura does not have these — it only supports `_eq`, `_neq`, `_in`, `_nin`, `_is_null` for enums.

- [x] Remove `_gt`/`_lt`/`_gte`/`_lte` from table-based enum comparison types only (PG native enums keep them per P10.9)
- [x] 15 tests

### P12.13 — Boolean Columns in Max/Min OrderBy (Low) ✅

Hakkyra includes boolean columns in `*MaxOrderBy` / `*MinOrderBy` types (e.g., `BrandCurrencyMaxOrderBy.active`, `CounterMaxOrderBy.autostart`, `GameMaxOrderBy.freespins`, `FileMaxOrderBy.isUploaded`, etc.). Hasura excludes booleans from min/max ordering.

- [x] Exclude boolean columns from `*MaxOrderBy` / `*MinOrderBy` input types
- [x] 3 tests

### P12.14 — `distinctOn` Arg Missing on Computed Field Array Relationships (Low)

3 computed field array relationships are missing the `distinctOn` argument:
- `Game.brands(distinctOn: [BrandSelectColumn!])`
- `Player.data(distinctOn: [JsonResultSelectColumn!])`
- `PlayerLimit.currentCounter(distinctOn: [PlayerLimitCounterSelectColumn!])`

- [ ] Add `distinctOn` arg to computed field array relationship fields

### P12.15 — Scalar Casing Mismatches: `Json`/`json`, `numeric`/`Numeric`, `jsonb`/`Jsonb` (Low)

Hasura uses lowercase scalars in some contexts: `numeric` for action args (e.g., `requestWithdrawal(amount: numeric!)`), `Json` (PascalCase) for tracked function args, `jsonb` (lowercase) in some types. Hakkyra consistently uses PascalCase (`Numeric`, `json`, `Jsonb`).

Player role examples: `startDeposit(amount: numeric!)` → hakkyra has `Numeric!`, `updateLimit(amount: numeric)` → hakkyra has `Numeric`.

- [ ] Investigate Hasura's scalar casing rules — when does it use lowercase vs PascalCase?
- [ ] Match Hasura's casing for each scalar context

### P12.16 — Missing Aggregate OrderBy Types (Low)

15 `*AggregateOrderBy` types present in Hasura are missing in Hakkyra:
- `BrandAggregateOrderBy`, `BrandMaxOrderBy`, `BrandMinOrderBy`
- `JsonResultAggregateOrderBy`
- `PlayerLimitCounter{Aggregate,Avg,Max,Min,Stddev,StddevPop,StddevSamp,Sum,VarPop,VarSamp,Variance}OrderBy`

These are needed for ordering parent rows by aggregate values of array relationships.

- [ ] Generate `*AggregateOrderBy` types for array relationships that currently lack them
- [ ] Investigate why Brand and PlayerLimitCounter are missing (possibly related to P11.13 DB mismatch)

### P12.17 — Missing Constraint Enum Values (Low)

Many `*Constraint` enums are missing unique index entries that Hasura includes. Examples: `BonusConstraint.bonusNameIdx`, `CampaignConstraint.campaignCheckingGroupIdx`, `GameConstraint.externalIdKey`, etc. (~30 missing values across ~20 enums).

- [ ] Introspect unique indexes from PostgreSQL and include in Constraint enums
- [ ] Verify these are real DB indexes vs Hasura metadata artifacts

### P12.18 — Update Mutation `_set` Nullability (Medium) ✅

Hasura: `updateFooByPk(_set: FooSetInput)` — `_set` is nullable (optional).
Hakkyra: `updateFooByPk(_set: FooSetInput!)` — `_set` is non-null (required).

This means in Hasura you can call `updateFooByPk(pkColumns: ..., _inc: ...)` without `_set`. In hakkyra, `_set` is always required.

- [x] Make `_set` nullable on `updateByPk`, `update`, and `updateMany` mutations
- [x] 1 test

### P12.19 — Tracked Function Mutations Missing Query Args (Medium)

Hasura tracked function mutations that return SETOF include query-style args: `distinctOn`, `limit`, `offset`, `orderBy`, `where`. Hakkyra only has `args`.

Affected mutations: `acceptContract`, `contentEvent`, `rejectContract`, `backofficeSetContract`, `createPayment`.
Affected queries: `getMarketingContracts`, `getPlayerMonthlySummary`, `getTournamentLeaderboard`, `getTournamentLeaderboardCount`.

- [ ] Add `distinctOn`, `limit`, `offset`, `orderBy`, `where` args to tracked function fields returning SETOF (both queries and mutations)

### P12.19b — Tracked Function `args` Nullability Depends on Required Args (Medium) ✅

P11.6 made all tracked function `args` non-null. But Hasura makes `args` nullable when ALL user-facing args (excluding `hasura_session`) have defaults. If any user-facing arg is required, `args` is non-null.

Examples: `latestWins(args: LatestWinsArgs)` — nullable because `cutoff` has a default. `acceptContract(args: AcceptContractArgs!)` — non-null because it has required args.

- [x] Make `args` nullable when all user-facing function parameters have defaults
- [x] Keep `args` non-null when any parameter lacks a default
- [x] `userArgsAllHaveDefaults()` helper using PG `numArgsWithDefaults` metadata

### P12.20 — Enum/UUID Columns Missing from Max/Min Aggregate Fields (Medium) ✅

Hasura includes enum-typed and UUID columns in `*MaxFields`/`*MinFields` (e.g., `PaymentMaxFields.paymentType`, `PlayerMaxFields.token`, `WalletMaxFields.status`). Hakkyra excludes them.

54 fields affected across ~25 types. These are useful — enums have ordering (alphabetic), UUIDs have ordering (lexicographic).

- [x] Include enum-typed columns in Max/Min aggregate fields (with correct enum type)
- [x] Include UUID columns in Max/Min aggregate fields
- [x] 5 tests

### P12.21 — Inet/Interval Comparison Exp Missing Order Operators (Low) ✅

`InetComparisonExp` and `IntervalComparisonExp` are missing `_gt`, `_gte`, `_lt`, `_lte` operators in Hakkyra. Hasura includes them.

- [x] Add ordering operators to Inet and Interval comparison expression types
- [x] Tests in comparison-expression-fixes.test.ts

### P12.22 — Role-Scoped Introspection (Medium)

Hakkyra returns the full schema (4602 types) regardless of the requesting role. Hasura scopes introspection by role (e.g., 2810 types for backoffice). When using admin key with `x-hasura-role` header, hakkyra should return the role-specific schema.

- [ ] Support `x-hasura-role` header with admin secret for role-scoped introspection/SDL
- [ ] Filter schema types, fields, and root operations by the role's permissions

### P12.23 — InsertInput/SetInput Expose Admin-Only Columns to Non-Admin Roles (Medium)

Hakkyra's InsertInput and SetInput types include ALL introspected columns regardless of role permissions. Hasura scopes these by role — backoffice InsertInput/SetInput only include columns that role has insert/update permission for.

627 extra input fields found in backoffice comparison. Example: `CurrencyInsertInput` in hakkyra includes `createdAt`, `updatedAt`, `bigWinThreshold` which backoffice shouldn't see.

- [ ] Scope InsertInput columns by insert permission column list
- [ ] Scope SetInput columns by update permission column list

### P12.24 — Extra Types Only in Hakkyra (Cleanup)

621 types exist only in Hakkyra. Most are intentional extensions:
- 342 `*GroupByAggregate` types (P11.14 extension)
- 273 `*GroupByKeys` + `*UpdateManyInput` types (Hakkyra-specific mutation approach)
- 3 extra BoolExp/SelectColumn types for native queries
- Extra scalars: `Bytea`, `Time`, `NumericComparisonExpLm`, `BigintComparisonExpLm`

- [ ] Decide on GroupBy extension: keep (document as extension) or make opt-in?
- [ ] Decide on UpdateManyInput: replace with Hasura's `*Updates` approach (P12.3) or keep both?
- [ ] Audit extra scalars — remove if unused

---

## YAML Configuration Documentation

Generate comprehensive API documentation for all YAML configuration files from Zod schemas. Documentation lives as `.describe()` annotations on Zod schema fields — a single source of truth for validation, types, and docs.

### Approach

- [x] Add `.describe()` to all Zod fields in `src/config/schemas.ts` (raw YAML schemas) and `src/config/schemas-internal.ts` (internal schemas)
- [x] Build doc generator that walks Zod schemas and emits structured documentation (field name, type, default, required/optional, description)
- [x] `hakkyra docs-config` CLI command — outputs generated config reference (Markdown or JSON)
- [x] Cover all config files: `hakkyra.yaml`, `databases.yaml`, table YAML, `actions.yaml`, `cron_triggers.yaml`, `functions.yaml`, `query_collections.yaml`, `rest_endpoints.yaml`, `inherited_roles.yaml`

### Scope

- [x] `hakkyra.yaml` — server, auth, graphql, rest, docs, schema, webhook, redis, job_queue sections
- [x] `databases.yaml` — connection config, pools, replicas, session, native_queries, logical_models
- [x] Table YAML — table config, permissions (select/insert/update/delete), relationships, computed fields, event triggers, `is_enum`, `configuration` block
- [x] `actions.yaml` + `actions.graphql` — action definitions, permissions, transforms, async config
- [x] `cron_triggers.yaml` — schedule, webhook, retry config, headers
- [x] `functions.yaml` — tracked function config, exposed_as, custom_root_fields, permissions
- [x] `query_collections.yaml` + `rest_endpoints.yaml` — collection definitions, endpoint routing

---

## Admin UI

Web-based admin console served by Hakkyra itself, enabled via `hakkyra.yaml`. Requires admin secret to access. Provides a unified interface for exploring, testing, and managing the API and its metadata.

### Config

```yaml
admin_ui:
  enabled: true        # default: false
  path: /console       # default: /console
```

### Features

- [ ] **Role switcher** — Switch between roles (including inherited roles) to test the API as different users; injects appropriate session variables
- [ ] **GraphQL playground** — Embedded GraphQL IDE (GraphiQL or similar) with role-aware schema, auto-complete, query history
- [ ] **REST playground** — REST API explorer with request builder, generated from OpenAPI spec; role-aware endpoint visibility
- [ ] **Metadata editor** — UI for editing YAML metadata files (tables, permissions, relationships, actions, cron triggers, functions, REST endpoints); validates against Zod schemas before saving; triggers hot reload in dev mode
- [ ] **Database browser** — List all PG schemas and tables (tracked and untracked); show table content with pagination, filtering, sorting; one-click "track table" to add untracked tables to metadata YAML; column details (type, nullable, default, constraints)
- [ ] **Table configuration UI** — Configure tracked tables: set permissions per role (column selection, row-level filters, presets), manage relationships, computed fields, event triggers; structured form with raw YAML toggle; changes write to metadata YAML files
- [ ] **Schema explorer** — Browse generated GraphQL types, relationships, permissions per role; visual relationship graph
- [ ] **Event/cron monitor** — View event trigger delivery status, cron trigger history, failed deliveries, retry queue

### Technical Approach

- [ ] Evaluate existing tools: GraphiQL, Apollo Sandbox, Swagger UI, Monaco editor
- [ ] Static SPA bundled into Hakkyra (served from memory, no external CDN)
- [ ] Admin secret auth gate (same `x-hasura-admin-secret` header used by API)
- [ ] Backend API endpoints under `/console/api/` for metadata read/write operations
- [ ] Dev mode: file write + hot reload; production mode: read-only explorer

---

## Test Summary

| Suite | Tests | Status |
|-------|-------|--------|
| Config loader | 32 | Pass |
| Introspection | 30 | Pass |
| Permissions | 41 | Pass |
| SQL compiler | 35 | Pass |
| Schema generator | 54 | Pass |
| REST filters | 30 | Pass |
| Server / E2E | 75 | Pass |
| Events | 9 | Pass |
| Crons | 14 | Pass |
| Subscriptions | 20 | Pass |
| Streaming subscriptions | 13 | Pass |
| Actions | 19 | Pass |
| Async actions | 23 | Pass |
| Computed fields | 50 | Pass |
| Upsert | 22 | Pass |
| Distinct | 22 | Pass |
| Returning rels | 16 | Pass |
| Prepared statements | 13 | Pass |
| Read-your-writes | 15 | Pass |
| GROUP BY | 18 | Pass |
| Action transforms | 32 | Pass |
| Batch operations | 26 | Pass |
| Action relationships | 13 | Pass |
| Statistical aggregates | 15 | Pass |
| Zod schemas | 241 | Pass |
| Tracked functions | 43 | Pass |
| Relationship ordering | 15 | Pass |
| Array comparison | 24 | Pass |
| Role-aware docs | 14 | Pass |
| Permission gaps | 49 | Pass |
| Relationship gaps | 68 | Pass |
| Security tests | 28 | Pass |
| Hasura REST endpoints | 5 | Pass |
| Config unsupported | 37 | Pass |
| REST permissions | 26 | Pass |
| JWT admin role | 9 | Pass |
| CRUD operations | 20 | Pass |
| **Total** | **1445** | **46 suites, 1445 passing** |
