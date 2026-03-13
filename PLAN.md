# Hakkyra — Implementation Plan

> A Node.js/TypeScript framework for auto-generating GraphQL + REST APIs from PostgreSQL, with YAML metadata configuration (compatible with Hasura metadata).

---

## Architecture Overview

```
                    ┌─────────────────────────────────────────────┐
                    │              Hakkyra Server                  │
                    │                                             │
  HTTP ────────────►│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
  GraphQL ─────────►│  │  Router  │──│  Auth    │──│Permission│  │
  WebSocket ───────►│  │ (Fastify)│  │(JWT/Hook)│  │ Compiler │  │
                    │  └────┬─────┘  └──────────┘  └────┬─────┘  │
                    │       │                           │         │
                    │  ┌────▼─────────────────────────▼──────┐  │
                    │  │         Schema Engine                 │  │
                    │  │  ┌────────┐ ┌────────┐ ┌──────────┐  │  │
                    │  │  │GraphQL │ │ REST   │ │ Actions  │  │  │
                    │  │  │  Gen   │ │  Gen   │ │(webhooks)│  │  │
                    │  │  └───┬────┘ └───┬────┘ └────┬─────┘  │  │
                    │  │      └──────┬───┘           │        │  │
                    │  │      ┌──────▼───────────────▼──┐     │  │
                    │  │      │    SQL Query Compiler    │     │  │
                    │  │      └──────────┬──────────────┘     │  │
                    │  └────────────────┬──────────────────┘  │
                    │                   │                      │
                    │  ┌────────────────▼──────────────────┐  │
                    │  │       Connection Manager           │  │
                    │  │  ┌─────────┐   ┌──────────────┐   │  │
                    │  │  │ Primary │   │ Read Replicas │   │  │
                    │  │  └─────────┘   └──────────────┘   │  │
                    │  │  R/W consistency · Prepared stmts  │  │
                    │  └───────────────────────────────────┘  │
                    │                                         │
                    │  ┌─────────┐ ┌──────────┐ ┌─────────┐  │
                    │  │ Events  │ │  Crons   │ │  Subs   │  │
                    │  │ Manager │ │ (JobQueue│ │ Manager │  │
                    │  └─────────┘ └──────────┘ └─────────┘  │
                    │         ▲ Job Queue Abstraction ▲        │
                    │         │  (pg-boss / BullMQ)   │        │
                    └─────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js 20+ / TypeScript 5 | Accessible, large ecosystem |
| Database | PostgreSQL 17+ | Minimum supported version |
| HTTP Server | Fastify 5 | Best performance, plugin system, good WebSocket support |
| GraphQL Server | Mercurius 16 (on Fastify) | graphql-jit for performance, built-in subscriptions |
| GraphQL Engine | graphql-js 16 | Standard foundation |
| WebSocket Subscriptions | graphql-ws 6 | Modern standard protocol |
| JWT Auth | jose 6 | Async, JWKS support, no native deps |
| PostgreSQL Client | pg 8 (node-postgres) | Mature, full-featured |
| DB Event Notifications | pg-listen 1 | Reconnection, JSON parsing |
| Job Queue | pg-boss 12 (default) / BullMQ 5 (optional) | pg-boss: PostgreSQL-native; BullMQ: Redis-based alternative |
| SQL Query Building | Custom compiler | AST-walking, single-query generation |
| Redis Pub/Sub | ioredis 5 (optional) | Multi-instance subscription fanout |
| Config Validation | Zod 4 | Runtime validation + compile-time type inference via `z.infer<>` |
| Config Format | YAML metadata (Hasura-compatible) | Migration path from existing Hasura setups |
| Structured Logging | pino 10 | JSON structured logs, optional pino-pretty for dev |

### Why Mercurius over Yoga

- **graphql-jit**: Compiles repeated queries into optimized JS functions (2-10x faster)
- **Native Fastify**: Deepest integration with our HTTP layer
- **Built-in subscription support**: Both own protocol and graphql-ws
- **Built-in DataLoader integration**: Automatic query batching

### Why Custom SQL Compiler over PostGraphile-as-library

PostGraphile is excellent but:
- We need application-level permission compilation (not PostgreSQL RLS)
- We need custom YAML config parsing (not PostGraphile's smart tags)
- We want full control over the SQL shape for custom optimizations
- PostGraphile V5 (Grafast) has a steep learning curve and its API was still stabilizing

### Why Zod over AJV

- **Type inference**: `z.infer<typeof Schema>` gives compile-time types from runtime schemas — single source of truth
- **Composability**: Schemas compose naturally via `.extend()`, `.merge()`, `.pick()`
- **Better DX**: Clearer error messages, smaller API surface, no separate schema language
- **Bundle size**: Smaller than AJV + JSON Schema definitions

---

## Core Modules

### Module 1: Configuration Loader (`src/config/`)

**Goal**: Parse YAML metadata (compatible with Hasura metadata format) + Hakkyra extensions.

```
metadata/
  version.yaml                    # { version: 3 }
  databases/
    databases.yaml                # Connection configs
    default/
      tables/
        tables.yaml               # Index of tracked tables
        public_users.yaml         # Per-table config
        public_articles.yaml
  actions.yaml                    # Custom actions (REST handlers in GraphQL)
  actions.graphql                 # Action type definitions
  cron_triggers.yaml              # Scheduled triggers
  api_config.yaml                 # Hakkyra extension: renaming, custom SQL, docs
```

**Hakkyra extensions** (beyond the base Hasura-compatible metadata format):

```yaml
# api_config.yaml — Hakkyra-specific configuration
table_aliases:
  usr_accounts: users             # GraphQL type: Users, REST: /users
  ord_items: orderItems
  prd_catalog: products

custom_queries:
  - name: userWithStats
    type: query
    sql: |
      SELECT u.*,
        (SELECT count(*) FROM orders WHERE user_id = u.id) as order_count,
        (SELECT sum(amount) FROM orders WHERE user_id = u.id) as total_spent
      FROM usr_accounts u
      WHERE u.id = $1
    params:
      - name: id
        type: uuid
    returns: UserWithStats
    permissions:
      - role: user
        filter: { id: { _eq: X-Hasura-User-Id } }
      - role: admin

rest_endpoints:
  auto_generate: true
  base_path: /api/v1
  pagination:
    default_limit: 20
    max_limit: 100
  overrides:
    users:
      - method: GET
        path: /users/:id
        operation: select_by_pk
      - method: GET
        path: /users
        operation: select
        default_order: created_at:desc

api_docs:
  generate: true
  llm_format: true
```

**Implementation approach:**
- Parse YAML with `js-yaml` (supports `!include` custom tags)
- Validate config with Zod schemas at loading boundaries (`src/config/schemas.ts`)
- Infer all TypeScript config types from Zod schemas via `z.infer<>`
- Validate environment variable references at startup (`src/config/env.ts`)
- Merge base metadata tables with Hakkyra extensions
- Watch config files for changes in dev mode (hot reload via `src/config/watcher.ts`)

**Files:**
- `loader.ts` — YAML config parser with `!include` support
- `schemas.ts` — Zod schemas for raw YAML structures (22 schemas)
- `schemas-internal.ts` — Zod schemas for processed internal config (24 schemas)
- `validator.ts` — Semantic validation (cross-references, operator checks)
- `env.ts` — Environment variable validation (fail-fast on missing vars)
- `watcher.ts` — File system watcher for dev mode hot reload
- `types.ts` — Re-exports of Zod-inferred types

---

### Module 2: PostgreSQL Introspection (`src/introspection/`)

**Goal**: Read the database schema and build an in-memory model.

**Custom introspection queries** for:
- Tables, views, materialized views
- Columns with types, defaults, nullability
- Primary keys, unique constraints
- Foreign key relationships
- Indexes
- Enums, composite types, domains
- Functions (for computed fields)

**Startup flow:**
1. Introspect PostgreSQL catalog via dedicated queries (`queries.ts`)
2. Map PG types → GraphQL scalar types (`type-map.ts`)
3. Load YAML metadata
4. Merge: tracked tables from YAML matched against introspected schema (`merger.ts`)
5. Auto-detect relationships from foreign keys
6. Validate: warn about tracked tables that don't exist, untracked tables
7. Build internal schema model

**Files:**
- `introspector.ts` — Main introspection coordinator
- `queries.ts` — PostgreSQL catalog queries (tables, columns, PKs, FKs, indexes, enums, functions)
- `type-map.ts` — PG type → GraphQL scalar mapping
- `merger.ts` — Merge introspection results with YAML config

---

### Module 3: GraphQL Schema Generator (`src/schema/`)

**Goal**: Generate a complete GraphQL schema from the internal model.

**For each tracked table, generate:**
- `GraphQLObjectType` with column fields and relationship fields
- Filter input types (`BoolExp` per table, camelCase field names)
- Order-by input types
- Mutation input types (`InsertInput`, `SetInput`, `PkColumnsInput`, `OnConflict`)
- Aggregate types (count, sum, avg, min, max, nodes, grouped aggregates)
- `MutationResponse` type (affectedRows, returning)
- Query root fields (e.g. `users`, `userByPk`, `usersAggregate`)
- Mutation root fields (e.g. `insertUsers`, `updateUserByPk`, `deleteUsers`)
- Subscription root fields

**Key design: Resolver factory pattern**

Nine auto-generated resolver factories: SELECT list, SELECT by PK, SELECT aggregate, INSERT, INSERT_ONE, UPDATE, UPDATE_BY_PK, DELETE, DELETE_BY_PK. Each calls the SQL query compiler with permission injection.

**Naming conventions:**
- PascalCase type names
- camelCase field/argument names
- UPPER_CASED enum values

**Files:**
- `generator.ts` — Main schema generator, root field registration
- `type-builder.ts` — GraphQL type construction, naming utilities
- `resolvers.ts` — All 9 resolver factories
- `subscription-resolvers.ts` — Subscription subscribe functions (AsyncIterable)
- `resolve-info.ts` — GraphQL look-ahead: parse selection sets for SQL optimization
- `filters.ts` — BoolExp input type generation
- `inputs.ts` — Mutation input types, aggregate types, order-by types
- `scalars.ts` — Custom scalar types (UUID, DateTime, JSON, JSONB, BigInt, BigDecimal, Date, Time, Interval, Bytea, Inet)
- `custom-queries.ts` — Register custom SQL queries/mutations from api_config.yaml

---

### Module 4: REST API Generator (`src/rest/`)

**Goal**: Auto-generate REST endpoints from the same table config.

**For each tracked table, generate:**

| Method | Path | Maps to |
|--------|------|---------|
| GET | /api/v1/users | `select` (list with filters) |
| GET | /api/v1/users/:id | `select_by_pk` |
| POST | /api/v1/users | `insert_one` |
| PATCH | /api/v1/users/:id | `update_by_pk` |
| DELETE | /api/v1/users/:id | `delete_by_pk` |

**Query parameters** (PostgREST-inspired):
- `column=eq.value` → `_eq`
- `column=neq.value` → `_ne`
- `column=gt.value`, `gte`, `lt`, `lte`
- `column=in.(a,b,c)` → `_in`
- `column=is.null` → `_is_null: true`
- `column=like.*pattern*` → `_like`

**The REST layer is thin** — it translates HTTP requests into the same internal query format used by GraphQL, then calls the same SQL compiler. Same permissions, same connection routing.

**Files:**
- `router.ts` — REST route registration and request handling
- `filters.ts` — PostgREST-style query parameter parsing
- `schemas.ts` — Zod schemas for request body and pagination validation

---

### Module 5: SQL Query Compiler (`src/sql/`)

**Goal**: Translate GraphQL/REST queries into optimized PostgreSQL SQL.

The most critical module. Approach: **AST-walking with look-ahead**, generating a single SQL query per GraphQL operation.

**Key technique: `json_build_object` + `jsonb_agg` for response shaping in SQL.**

A GraphQL query with nested relationships compiles to a single SQL query using correlated subqueries with `json_build_object` for object relationships and `jsonb_agg` for array relationships, with table aliases (t0, t1, t2...) for nesting depth.

**Compiler phases:**

1. **Parse**: Walk the GraphQL selection set (or REST query params)
2. **Permission injection**: For each table touched, look up the active role's permission and inject WHERE clauses
3. **Relationship expansion**: Detect relationship fields → generate correlated subqueries
4. **Column selection**: Only SELECT columns that are both requested AND permitted for the role
5. **Ordering & pagination**: Apply `ORDER BY`, `LIMIT`, `OFFSET`
6. **Aggregation**: Handle `_aggregate` fields (count, sum, avg, min, max, group by)
7. **Parameter collection**: Gather all values into a parameterized query ($1, $2, ...)

**Advanced features:**
- **ON CONFLICT** (upsert) with constraint/column targeting and WHERE on DO UPDATE
- **DISTINCT ON** with auto ORDER BY prepend
- **GROUP BY** in aggregations
- **UNNEST optimization** for bulk inserts (>500 rows)
- **Returning nested relationships** after mutations via CTE pattern
- **Custom query overrides**: Hand-written SQL from `api_config.yaml`

**Query caching**: LRU cache for compiled SQL templates keyed by `(queryHash, role)`. Only session variable values change between requests with the same query shape.

**Files:**
- `select.ts` — SELECT compilation (list, by PK, aggregate, relationships, distinct, group by)
- `insert.ts` — INSERT compilation (single, bulk, UNNEST, ON CONFLICT, column presets)
- `update.ts` — UPDATE compilation (by PK, bulk, permission filter, post-update check)
- `delete.ts` — DELETE compilation (by PK, bulk, permission filter)
- `where.ts` — WHERE clause compilation from BoolExp (all operators)
- `cache.ts` — LRU query plan cache by (queryHash, role)
- `utils.ts` — SQL helpers, parameter collection

---

### Module 6: Permission Compiler (`src/permissions/`)

**Goal**: Compile YAML permission rules (Hasura-compatible format) into SQL WHERE clauses.

**At startup:**
- Parse all permission YAML into an internal AST
- Pre-validate: referenced columns exist, operators are valid
- Build a lookup: `Map<table+role+operation, CompiledPermission>`

**At query time:**
- Look up `CompiledPermission` for the active role
- Substitute session variable placeholders with actual JWT claim values
- Return SQL fragment + parameters to inject into the query

**Supported operators:**
- Comparison: `_eq`, `_ne`, `_gt`, `_lt`, `_gte`, `_lte`, `_in`, `_nin`, `_is_null`
- Text: `_like`, `_nlike`, `_ilike`, `_nilike`, `_similar`, `_regex`, `_iregex`
- JSONB: `_contains`, `_contained_in`, `_has_key`, `_has_keys_any`, `_has_keys_all`
- Logical: `_and`, `_or`, `_not`
- Relationship: `_exists`

**Session variable resolution:** Any string value starting with `X-Hasura-` or `x-hasura-` is a session variable reference, resolved from JWT claims at query time, always injected as parameterized values.

**Column presets (`set`):** Force column values on INSERT/UPDATE (e.g., `set: { user_id: x-hasura-user-id }`).

**Admin bypass:** If `role === 'admin'`, skip all permission checks entirely.

**Files:**
- `compiler.ts` — Permission rule → SQL fragment compiler
- `lookup.ts` — Permission lookup map construction and querying

---

### Module 7: Authentication (`src/auth/`)

**Goal**: JWT verification with claims extraction (compatible with Hasura claims format).

**Auth chain:**
1. Check `x-hasura-admin-secret` header → admin bypass (timing-safe comparison)
2. Extract `Authorization: Bearer <token>` header
3. Verify JWT signature (HS256/384/512, RS256/384/512, ES256/384/512, EdDSA)
4. JWKS endpoint support with auto-rotation via `createRemoteJWKSet`
5. Extract session claims from configured namespace (default: `https://hasura.io/jwt/claims`)
6. Support `claims_map` for non-standard JWT layouts
7. Determine active role: `x-hasura-role` header override (if in `allowed-roles`) or `default-role`
8. If no token and `unauthorized_role` configured → use that role

**Webhook auth (alternative):**
- Forward request headers to configured webhook URL (GET or POST mode)
- Webhook returns session variables as JSON (X-Hasura-Role, X-Hasura-User-Id, etc.)
- In-memory TTL cache for webhook responses

**WebSocket auth:**
- Authenticate on connection init from `connectionParams` (JWT or admin secret)
- Multiple token formats supported (Authorization header, token field, nested headers)

**Files:**
- `jwt.ts` — JWT verification with jose (all algorithms, JWKS)
- `claims.ts` — Claims extraction with configurable namespace and claims_map
- `middleware.ts` — Fastify preHandler hook (auth chain orchestration)
- `webhook.ts` — Webhook-based authentication with TTL cache
- `ws-auth.ts` — WebSocket connection authentication

---

### Module 8: Subscriptions (`src/subscriptions/`)

**Goal**: Real-time GraphQL subscriptions over WebSocket.

**Approach: Hybrid (LISTEN/NOTIFY signal + targeted re-query + hash diff)**

1. Install PostgreSQL triggers on tracked tables that fire `NOTIFY` with table name + operation
2. Node.js listens via `pg-listen` on `hakkyra_changes` channel
3. On notification, find all active subscriptions that involve that table
4. Re-run only those subscription queries
5. Hash the result (SHA-256), compare with last sent → push only if changed
6. Debounced re-query (50ms window)

**WebSocket protocol: `graphql-ws`** (via Mercurius integration, 30s keep-alive)

**Multi-instance fanout (optional, requires Redis):**
When Redis is configured, the instance that receives a PG notification publishes it to the `hakkyra:sub:changes` Redis pub/sub channel. All other Hakkyra instances receive it via Redis SUBSCRIBE and re-query their local subscription clients. Each instance stamps messages with a UUID instance ID to skip its own messages (already handled locally via PG LISTEN). Uses two ioredis connections per instance (one blocked in subscribe mode, one for publish). Falls back to single-instance mode without Redis.

**Files:**
- `manager.ts` — Subscription registry, table index, hash-diff, debounced re-query
- `listener.ts` — pg-listen wrapper for `hakkyra_changes` channel
- `triggers.ts` — PG trigger installation and cleanup
- `redis-fanout.ts` — Redis pub/sub bridge for multi-instance fanout (optional, dynamic import of ioredis)

---

### Module 9: Event Triggers (`src/events/`)

**Goal**: Capture DB changes and deliver webhooks with at-least-once semantics.

**Architecture: Outbox pattern + job queue delivery**

1. YAML config defines event triggers per table (Hasura-compatible format)
2. At startup, install PostgreSQL triggers on configured tables
3. Triggers write to `hakkyra.event_log` table (same transaction as data change)
4. Job queue picks up events and delivers webhooks
5. Retry with exponential backoff on failure
6. Dead letter queue for permanently failed events

**Column-specific UPDATE triggers:** Only fire when tracked columns change.

**Session variable capture:** `current_setting('hasura.user')` captured at trigger time via NULLIF for empty string handling.

**Webhook payload format** compatible with Hasura event payload.

**Files:**
- `manager.ts` — Event trigger lifecycle orchestration
- `triggers.ts` — PG trigger function generation and installation
- `delivery.ts` — Event delivery workers, webhook payload building
- `schema.ts` — `hakkyra.event_log` table creation
- `invoke.ts` — Manual event trigger invocation API (`POST /v1/events/invoke/:trigger`)
- `cleanup.ts` — Daily cleanup job for delivered events (configurable retention)

---

### Module 10: Cron Triggers (`src/crons/`)

**Goal**: Scheduled webhook invocations via job queue.

**At startup:**
- Load `cron_triggers.yaml`
- Register each cron via job queue: `jobQueue.schedule('cron/name', cronExpr, payload)`
- Job queue handles distributed single-execution (advisory locks)

**Webhook payload format** compatible with Hasura cron payload (scheduled_time, payload, name, comment).

**Files:**
- `scheduler.ts` — Cron registration with job queue
- `worker.ts` — Cron job workers, webhook delivery

---

### Module 11: Actions (`src/actions/`)

**Goal**: Custom GraphQL operations backed by HTTP webhooks.

Actions let you define custom GraphQL types (in `actions.graphql`) backed by HTTP handlers (configured in `actions.yaml`) — compatible with Hasura action format.

**Webhook proxy mode:**
- Forward input + session variables to handler URL
- Header forwarding (configured headers + client header forwarding)
- Request/response transformation via template interpolation engine (`{{$body.field}}`, `{{$session_variables.x-hasura-user-id}}`)

**Async actions:**
- Return `{ actionId: UUID! }` immediately
- Worker processes webhook delivery asynchronously
- Store result/errors in `hakkyra.async_action_log` table
- Query result via `{name}Result(id: UUID!)` or `GET /v1/actions/:actionId/status`
- Status tracking: created → processing → completed/failed

**Action permissions:** Per-role permission enforcement.

**Action relationships:** Object/array relationships from action output to database tables, with full permission enforcement per relationship.

**Files:**
- `proxy.ts` — Webhook proxy with Hasura-compatible payload
- `schema.ts` — Action GraphQL schema generation, relationship fields
- `transform.ts` — Request/response template interpolation engine
- `async.ts` — Async action enqueue, worker, result retrieval
- `async-schema.ts` — Async action DB schema (`hakkyra.async_action_log`)
- `permissions.ts` — Role-based action permission checking
- `rest.ts` — Async action status REST endpoint

---

### Module 12: API Documentation Generator (`src/docs/`)

**Goal**: Auto-generate API documentation in multiple formats.

- **OpenAPI 3.1** spec at `/openapi.json` with LLM-friendly extensions
- **LLM-friendly compact JSON** at `/llm-api.json` — token-efficient format for LLM context windows
- **GraphQL SDL** at `/sdl` via `printSchema`

**Files:**
- `openapi.ts` — OpenAPI 3.1 spec generator
- `graphql-sdl.ts` — GraphQL SDL export
- `llm-format.ts` — LLM-friendly compact JSON format

---

### Module 13: Connection Manager (`src/connections/`)

**Goal**: Route queries to primary or read replicas with consistency guarantees.

**Routing rules:**
- GraphQL `Query` / REST `GET` → read replica (round-robin)
- GraphQL `Mutation` / REST `POST/PATCH/DELETE` → primary
- GraphQL `Subscription` queries → read replica
- After mutation: optionally route that user's reads to primary for N seconds (read-your-writes)

**Read-your-writes consistency:** In-memory `ConsistencyTracker` with configurable TTL window (default 5s). After a mutation, marks the user so subsequent reads within the window go to primary.

**Dual connection pool (PgBouncer compatibility):** Optional `databases.session.url_from_env` config provides a separate connection string for LISTEN/NOTIFY operations. This allows the main query/mutation pool to go through PgBouncer in transaction mode, while LISTEN/NOTIFY uses a direct PostgreSQL connection (or PgBouncer session mode). Falls back to the primary connection string when not configured.

**Prepared statement caching:** LRU-based `PreparedStatementManager` using stable hash-based statement names. PostgreSQL reuses server-side cached plans on subsequent executions. Disabled by default, enabled via config.

**Session variable injection:** Each query runs in a transaction with `SET LOCAL` via `set_config()`:
- `hasura.user` — full session claims JSON
- `hakkyra.user_id` — authenticated user ID
- `hakkyra.role` — active role

**Files:**
- `manager.ts` — Pool creation, read/write routing, session variable injection
- `consistency.ts` — Read-your-writes consistency tracker
- `prepared-statements.ts` — LRU prepared statement manager

---

### Module 14: Shared Infrastructure (`src/shared/`)

**Goal**: Cross-cutting utilities used by events, crons, and actions.

**Job Queue Abstraction:** `JobQueue` interface with `PgBossAdapter` (default, PostgreSQL-native) and `BullMQAdapter` (optional, requires Redis). Factory function selects provider from config. All event/cron/async-action consumers use the abstract interface.

**Files:**
- `webhook.ts` — Webhook delivery utility (fetch-based, timeout, header/URL env resolution, backoff calculator)
- `pg-boss-manager.ts` — pg-boss lifecycle manager (`hakkyra_boss` schema)
- `trigger-reconciler.ts` — Diff-based trigger reconciliation (only CREATE/DROP what changed)
- `job-queue/types.ts` — `JobQueue` interface, `JobHandler`, `QueueOptions`, `ScheduleOptions`
- `job-queue/pg-boss-adapter.ts` — pg-boss adapter
- `job-queue/bullmq-adapter.ts` — BullMQ adapter (optional, dynamic import)
- `job-queue/index.ts` — Factory function

---

### Module 15: CLI (`src/cli.ts`, `src/commands/`)

**Goal**: Command-line interface for starting and scaffolding projects.

**Commands:**
- `hakkyra start` — Production server start
- `hakkyra dev` — Development mode with config hot reload
- `hakkyra init [--force]` — Scaffold new project with example metadata
- `hakkyra --version` / `hakkyra --help`

**Backwards-compatible:** Flag-only syntax (`hakkyra --port 3000 --dev`) transparently routes to `start`.

**Files:**
- `cli.ts` — CLI dispatcher, argument parsing, help text
- `commands/start.ts` — Server startup logic (env validation → config load → create server)
- `commands/init.ts` — Project scaffolding

---

### Module 16: Server Wiring (`src/server.ts`)

**Goal**: Wire all modules together into a running server.

**Startup sequence:**
1. Create Fastify server with pino logger
2. Register auth preHandler hook
3. Register Mercurius GraphQL plugin (with ESM/CJS schema bridging)
4. Register REST routes
5. Register health endpoints (`/healthz`, `/readyz`)
6. Register doc endpoints (`/openapi.json`, `/llm-api.json`, `/sdl`)
7. Initialize job queue (pg-boss or BullMQ)
8. Initialize event triggers, cron triggers, async actions
9. Install subscription triggers, start change listener
10. Start dev mode config watcher (if `--dev`)

**Observability:**
- Request logging via `onResponse` hook (method, URL, status, time, role, GraphQL operation)
- Slow query detection with configurable threshold (default 200ms)

**Graceful shutdown order:**
1. Config watcher (if dev mode)
2. Change listener
3. Event manager
4. Job queue
5. Server
6. Connection pools

---

## Implementation Phases

### Phase 1: Core Engine (MVP) — COMPLETE

Config loader, PostgreSQL introspection, GraphQL schema generator, SQL compiler (SELECT/INSERT/UPDATE/DELETE with relationships), permission compiler, JWT/webhook authentication, REST API generator, connection manager, API documentation, server wiring, CLI entry point. 227 tests across 7 suites.

### Phase 2: Real-time & Events — COMPLETE

Subscriptions (LISTEN/NOTIFY + hash-diff + WebSocket), event triggers (outbox pattern + job queue delivery), cron triggers (job queue scheduling), shared webhook infrastructure. 36 tests across 3 suites.

### Phase 3: Advanced Features — COMPLETE

Actions (webhook proxy, async, transforms, relationships, permissions), job queue abstraction (pg-boss + BullMQ), advanced SQL (computed fields, upsert, DISTINCT ON, returning relationships, GROUP BY, batch UNNEST, prepared statements), read-your-writes consistency. 228 tests across 12 suites.

### Phase 4: Polish & Production — COMPLETE

CLI tool (start/dev/init), Zod validation & type inference, observability (structured logging, slow query detection), query plan caching, trigger reconciliation, Docker image, CI template. Dual connection pool for PgBouncer compatibility. Redis pub/sub fanout for multi-instance subscriptions. 228 Zod schema tests.

---

## Project Structure

```
hakkyra/
├── package.json
├── tsconfig.json
├── docker-compose.yml                 # PostgreSQL 17 for development/testing
├── Dockerfile                         # Production Docker image
├── .github/workflows/ci.yml          # GitHub Actions CI
├── src/
│   ├── cli.ts                         # CLI dispatcher
│   ├── index.ts                       # Programmatic API exports
│   ├── server.ts                      # Fastify server setup + module wiring
│   ├── types.ts                       # Shared types (z.infer<> from Zod schemas)
│   ├── commands/
│   │   ├── start.ts                   # hakkyra start / dev
│   │   └── init.ts                    # hakkyra init
│   ├── config/
│   │   ├── loader.ts                  # YAML config parser with !include
│   │   ├── schemas.ts                 # Raw YAML Zod schemas (22 schemas)
│   │   ├── schemas-internal.ts        # Internal config Zod schemas (24 schemas)
│   │   ├── validator.ts               # Semantic config validation
│   │   ├── env.ts                     # Environment variable validation
│   │   ├── watcher.ts                 # Dev mode file watcher
│   │   └── types.ts                   # Type re-exports
│   ├── introspection/
│   │   ├── introspector.ts            # PostgreSQL schema introspection
│   │   ├── queries.ts                 # PG catalog queries
│   │   ├── type-map.ts               # PG type → GraphQL scalar mapping
│   │   └── merger.ts                  # Merge introspection with YAML config
│   ├── schema/
│   │   ├── generator.ts               # GraphQL schema generator
│   │   ├── type-builder.ts            # Type construction, naming
│   │   ├── resolvers.ts               # 9 resolver factories
│   │   ├── subscription-resolvers.ts  # Subscription resolvers
│   │   ├── resolve-info.ts            # GraphQL look-ahead for SQL optimization
│   │   ├── filters.ts                 # BoolExp input type generation
│   │   ├── inputs.ts                  # Mutation inputs, aggregates, order-by
│   │   ├── scalars.ts                 # Custom scalar types
│   │   └── custom-queries.ts          # Custom SQL queries/mutations
│   ├── sql/
│   │   ├── select.ts                  # SELECT (list, PK, aggregate, relationships)
│   │   ├── insert.ts                  # INSERT (single, bulk, UNNEST, ON CONFLICT)
│   │   ├── update.ts                  # UPDATE (by PK, bulk)
│   │   ├── delete.ts                  # DELETE (by PK, bulk)
│   │   ├── where.ts                   # WHERE clause compilation
│   │   ├── cache.ts                   # LRU query plan cache
│   │   └── utils.ts                   # SQL helpers, parameter collection
│   ├── auth/
│   │   ├── jwt.ts                     # JWT verification (jose)
│   │   ├── claims.ts                  # Claims extraction
│   │   ├── middleware.ts              # Fastify auth hook
│   │   ├── webhook.ts                 # Webhook auth with TTL cache
│   │   └── ws-auth.ts                # WebSocket auth
│   ├── permissions/
│   │   ├── compiler.ts                # Permission → SQL compiler
│   │   └── lookup.ts                  # Permission lookup map
│   ├── rest/
│   │   ├── router.ts                  # REST route registration
│   │   ├── filters.ts                 # Query param → filter parsing
│   │   └── schemas.ts                 # Zod input validation schemas
│   ├── subscriptions/
│   │   ├── manager.ts                 # Subscription lifecycle
│   │   ├── listener.ts                # pg-listen wrapper
│   │   ├── triggers.ts               # PG trigger installation
│   │   └── redis-fanout.ts           # Redis pub/sub fanout (optional)
│   ├── events/
│   │   ├── manager.ts                 # Event trigger management
│   │   ├── triggers.ts                # PG trigger generation
│   │   ├── delivery.ts                # Webhook delivery worker
│   │   ├── schema.ts                  # event_log table creation
│   │   ├── invoke.ts                  # Manual invocation API
│   │   └── cleanup.ts                # Retention-based cleanup
│   ├── crons/
│   │   ├── scheduler.ts               # Job queue cron registration
│   │   └── worker.ts                  # Cron webhook delivery
│   ├── actions/
│   │   ├── proxy.ts                   # Webhook proxy
│   │   ├── schema.ts                  # Action GraphQL schema + relationships
│   │   ├── transform.ts              # Request/response transformation
│   │   ├── async.ts                   # Async action processing
│   │   ├── async-schema.ts           # async_action_log table
│   │   ├── permissions.ts            # Action permissions
│   │   └── rest.ts                    # Async action status endpoint
│   ├── connections/
│   │   ├── manager.ts                 # Pool manager + read/write routing
│   │   ├── consistency.ts            # Read-your-writes tracker
│   │   └── prepared-statements.ts    # Prepared statement LRU cache
│   ├── shared/
│   │   ├── webhook.ts                 # Webhook delivery utility
│   │   ├── pg-boss-manager.ts        # pg-boss lifecycle
│   │   ├── trigger-reconciler.ts     # Diff-based trigger reconciliation
│   │   └── job-queue/
│   │       ├── types.ts               # JobQueue interface
│   │       ├── pg-boss-adapter.ts    # pg-boss adapter
│   │       ├── bullmq-adapter.ts     # BullMQ adapter (optional)
│   │       └── index.ts              # Factory function
│   └── docs/
│       ├── openapi.ts                 # OpenAPI 3.1 generator
│       ├── graphql-sdl.ts            # SDL export
│       └── llm-format.ts            # LLM-friendly compact format
├── test/
│   ├── setup.ts                       # Test DB setup, JWT helpers
│   ├── helpers/
│   │   └── mock-webhook.ts           # Mock webhook server
│   ├── fixtures/
│   │   ├── init.sql                   # 18 tables + 1 materialized view + 5 enums + 3 computed fields
│   │   ├── hakkyra.yaml              # Test server config
│   │   └── metadata/                 # Hasura-compatible YAML metadata
│   └── *.test.ts                     # 23 test suites, 705 tests
```

---

## Key Dependencies

```json
{
  "dependencies": {
    "fastify": "^5.8.2",
    "fastify-plugin": "^5.1.0",
    "graphql": "^16.13.1",
    "graphql-ws": "^6.0.7",
    "jose": "^6.2.1",
    "js-yaml": "^4.1.1",
    "mercurius": "^16.8.0",
    "pg": "^8.20.0",
    "pg-boss": "^12.14.0",
    "pg-listen": "^1.7.0",
    "pino": "^10.3.1",
    "zod": "^4.3.6"
  },
  "optionalDependencies": {
    "bullmq": "^5.71.0",
    "ioredis": "^5.6.0"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.1.0",
    "@types/pg": "^8.18.0",
    "tsx": "^4.21.0",
    "pino-pretty": "^13.1.3"
  }
}
```

---

## Design Decisions Summary

| Decision | Choice | Alternative considered |
|----------|--------|----------------------|
| Don't use PostGraphile as library | Custom SQL compiler | PostGraphile V5 in library mode — too opinionated, different auth model |
| Don't use PostgreSQL RLS | Application-level permission injection | RLS — harder to debug, requires DB role per app role |
| Mercurius over Yoga | graphql-jit perf + Fastify integration | Yoga — more portable but we're committed to Fastify |
| YAML metadata (Hasura-compatible) | Migration path from Hasura | TypeScript config — better DX but breaks compat |
| Outbox pattern for events | Reliability, same-transaction | Direct LISTEN/NOTIFY — not durable |
| json_build_object SQL shaping | Single query, DB does the work | Application-side result shaping — more round trips |
| Hybrid subscriptions | Responsive + correct | Pure polling — simpler but less responsive |
| Zod over AJV | Type inference + runtime validation in one | AJV + manual types — two sources of truth to maintain |
| Job queue abstraction | pg-boss default + BullMQ option | Hard-code pg-boss — less flexible for Redis users |
