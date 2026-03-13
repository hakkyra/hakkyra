# Hakkyra Backlog

## Phase 1: Core Engine (MVP) — COMPLETE

### P1.1 — Project Setup
- [x] Initialize Node.js project with TypeScript
- [x] Configure tsconfig.json, ESLint, Vitest
- [x] Install core dependencies (fastify, mercurius, pg, jose, pg-boss, pg-listen, pino)
- [x] Create directory structure
- [x] Define shared type definitions (src/types.ts)
- [x] PostgreSQL 17 (docker-compose)

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
- [x] Session variable resolution (X-Hasura-* → JWT claim values)
- [x] Column-level permission enforcement (allowed columns per role per operation)
- [x] Column presets (set) for insert/update
- [x] Row limit enforcement
- [x] Aggregation permission flag
- [x] Admin role bypass
- [x] Permission lookup: Map<table+role+operation, CompiledPermission>
- [x] Unit tests: all operators, session variable substitution, edge cases (31 tests)

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
- [x] Generate mutation input types (camelCase: InsertInput, SetInput, PkColumnsInput)
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
  - [x] camelCase response key remapping
- [x] Custom scalar types (UUID, DateTime, JSON, JSONB, BigInt, BigDecimal, etc.)
- [x] graphql-default naming convention
  - [x] PascalCase type names
  - [x] camelCase field/argument names
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
- [x] Test fixtures: 18 tables + 1 materialized view + 5 enums + 3 computed fields
- [x] YAML metadata in Hasura-compatible format (19 table configs, 5 roles, 3 inherited roles)
- [x] Event triggers, cron triggers, actions, REST endpoints, query collections
- [x] Seed data: fixture data for all tracked tables
- [x] JWT test helpers (HS256 tokens for test roles)

---

## Phase 2: Real-time & Events — COMPLETE

### Shared Infrastructure (`src/shared/`)
- [x] Webhook delivery utility (fetch-based, timeout, header/URL env resolution)
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
- [x] Integration tests (16 tests)

### P3.1.5 — Job Queue Abstraction (`src/shared/job-queue/`)
- [x] `JobQueue` interface abstracting pg-boss
- [x] `PgBossAdapter` + `BullMQAdapter` (optional, requires Redis)
- [x] Factory function with config-driven provider selection
- [x] All consumers refactored to use `JobQueue` interface

### P3.2 — Advanced SQL Features
- [x] Computed fields (from PG functions, 17 tests)
- [x] ON CONFLICT (upsert) for inserts (22 tests)
- [x] Distinct queries — DISTINCT ON (22 tests)
- [x] Returning nested relationships after mutations (16 tests)
- [x] GROUP BY support in aggregations (18 tests)
- [x] Batch operations optimization — UNNEST for large inserts, updateMany (26 tests)
- [x] Prepared statement caching — LRU-based, config-driven (13 tests)

### P3.3 — Read-Your-Writes Consistency
- [x] ConsistencyTracker with configurable window (default 5s, 15 tests)

---

## Phase 4: Polish & Production — IN PROGRESS

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
- [ ] Memory profiling for subscription-heavy workloads

### P4.4 — Developer Experience
- [x] Docker image + docker-compose for quick start (`Dockerfile`, `docker-compose.quickstart.yml`)
- [x] GitHub Actions CI template (`.github/workflows/ci.yml`)

## Improvements
- [ ] Dual connection pool — dedicated session-mode pool for LISTEN/NOTIFY, separate pooled connections for queries/mutations (enables PgBouncer transaction-mode compatibility)
- [ ] Redis pub/sub fanout for multi-instance subscriptions

---

## Test Summary

| Suite | Tests | Status |
|-------|-------|--------|
| Config loader | 19 | Pass |
| Introspection | 30 | Pass |
| Permissions | 31 | Pass |
| SQL compiler | 24 | Pass |
| Schema generator | 34 | Pass |
| REST filters | 30 | Pass |
| Server / E2E | 59 | Pass |
| Events | 9 | Pass |
| Crons | 14 | Pass |
| Subscriptions | 13 | Pass |
| Actions | 16 | Pass |
| Async actions | 18 | Pass |
| Computed fields | 17 | Pass |
| Upsert | 22 | Pass |
| Distinct | 22 | Pass |
| Returning rels | 16 | Pass |
| Prepared statements | 13 | Pass |
| Read-your-writes | 15 | Pass |
| GROUP BY | 18 | Pass |
| Action transforms | 32 | Pass |
| Batch operations | 26 | Pass |
| Action relationships | 13 | Pass |
| Zod schemas | 214 | Pass |
| **Total** | **705** | **23 suites, all passing** |
