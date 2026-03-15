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
- [x] Load `api_config.yaml` (table aliases, custom queries, REST overrides, doc config)
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
- [x] Auto-detect relationships from FKs, merge with config-defined relationships
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
- [x] Custom query override support (`src/schema/custom-queries.ts`)
  - [x] Register custom queries/mutations in GraphQL schema from api_config.yaml
  - [x] Session variable injection into SQL parameters
  - [x] Role-based permission enforcement
  - [x] Auto-generate or reuse output types from SQL column parsing
  - [x] E2E tests (8 tests: custom query resolution, parameterized queries, mutations)
- [x] Query caching: LRU cache for compiled SQL templates by (queryHash, role) (`src/sql/cache.ts`)

### P1.7 — GraphQL Schema Generator (`src/schema/`)
- [x] Generate GraphQLObjectType per tracked table
  - [x] Map PG columns → GraphQL fields with correct scalar types
  - [x] Apply table aliases for type naming
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
- [x] Apply table aliases for URL paths
- [x] Proper HTTP status codes (200, 201, 204, 400, 401, 403, 404)
- [x] REST filter parsing tests (30 tests)
- [x] E2E REST tests (list, get, insert, update, delete, permission enforcement)
- [x] REST endpoint overrides from config (custom paths, default_order per operation)

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
- [x] Action permissions per role
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

**REST** (`src/config/loader.ts`)
- [x] `rest.defaultLimit` → `20`
- [x] `rest.maxLimit` → `100`
- [x] `rest.autoGenerate` → `true`
- [x] `rest.basePath` → `'/api'`

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

## Test Summary

| Suite | Tests | Status |
|-------|-------|--------|
| Config loader | 32 | Pass |
| Introspection | 30 | Pass |
| Permissions | 41 | Pass |
| SQL compiler | 35 | Pass |
| Schema generator | 52 | Pass |
| REST filters | 30 | Pass |
| Server / E2E | 79 | Pass |
| Events | 9 | Pass |
| Crons | 14 | Pass |
| Subscriptions | 17 | Pass |
| Streaming subscriptions | 13 | Pass |
| Actions | 19 | Pass |
| Async actions | 18 | Pass |
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
| Zod schemas | 243 | Pass |
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
| **Total** | **1194** | **36 suites, 1194 passing** |
