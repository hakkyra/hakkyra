# Hakkyra

*Häkkyrä* (Finnish): a thingy, contraption, or gadget — an indefinable or convoluted-looking device. *"Kummallinen rautalankahäkkyrä."*

Auto-generate GraphQL + REST APIs from PostgreSQL with Hasura-compatible YAML metadata configuration.

Hakkyra introspects your PostgreSQL database, reads YAML metadata (compatible with Hasura's metadata format), and serves a fully-featured GraphQL and REST API with authentication, role-based permissions, real-time subscriptions, event triggers, and cron scheduling — all without writing application code.

## Features

- **GraphQL API** — auto-generated queries, mutations, and subscriptions for every tracked table
- **REST API** — CRUD endpoints with PostgREST-style filtering and pagination
- **Permissions** — row-level and column-level security per role, compiled to SQL at startup, with inherited role support and column presets
- **Authentication** — JWT (HS256, RS256, ES256, Ed25519), JWKS auto-rotation, webhook auth
- **Relationships** — object and array relationships resolved in a single SQL query
- **Actions** — proxy mutations/queries to external webhook handlers with request/response transforms, async support, and action relationships
- **Tracked functions** — expose PostgreSQL functions as top-level Query/Mutation fields with permission enforcement
- **Computed fields** — virtual fields backed by PostgreSQL functions
- **Table-based enums** — `is_enum: true` tables become GraphQL enum types; FK columns auto-typed
- **Subscriptions** — real-time updates via WebSocket (graphql-ws protocol) with LISTEN/NOTIFY + Redis pub/sub fanout for multi-instance deployments
- **Streaming subscriptions** — cursor-based streaming with `batchSize` and `cursor` arguments
- **Event triggers** — capture INSERT/UPDATE/DELETE changes and deliver webhooks with retry
- **Cron triggers** — scheduled webhook invocations via pg-boss or BullMQ
- **Custom queries** — hand-written SQL overrides registered as GraphQL operations
- **Upsert** — ON CONFLICT support for inserts
- **Batch operations** — optimized UNNEST-based bulk inserts and updateMany
- **Distinct queries** — DISTINCT ON support
- **Read replicas** — automatic read/write routing with round-robin
- **API docs** — OpenAPI 3.1, GraphQL SDL, and LLM-friendly compact format
- **Hot reload** — `--dev` mode watches config files and reloads schema without restart

## Quick Start

### Prerequisites

- Node.js >= 20
- PostgreSQL 17+

### Install and Run

```bash
npm install
npm run build
hakkyra --config ./hakkyra.yaml --metadata ./metadata
```

Or in development with hot reload:

```bash
npm run dev -- --dev --config ./hakkyra.yaml --metadata ./metadata
```

### Docker Compose (for development/testing)

```bash
docker compose up -d   # starts PostgreSQL 17
npm test               # runs the full test suite (~1200 tests)
```

## Configuration

Hakkyra uses two configuration layers:

### 1. Server config (`hakkyra.yaml`)

All options use `snake_case` in YAML. Every option below is optional unless marked **required**.

```yaml
# ─── Server ──────────────────────────────────────────────────────────────────
server:
  port: 3000                    # HTTP port (default: 3000)
  host: 0.0.0.0                 # Bind address (default: 0.0.0.0)
  log_level: info               # Pino log level (default: info)
  body_limit: 1048576           # Max request body in bytes (default: 1MB)
  schema_name: hakkyra          # Internal PG schema for triggers/events (default: hakkyra)
  stringify_numeric_types: false # Return numeric types as strings (default: false)
  slow_query_threshold_ms: 200  # Log queries slower than this (default: 200)

# ─── Authentication ──────────────────────────────────────────────────────────
auth:
  admin_secret_from_env: HAKKYRA_ADMIN_SECRET  # Env var with admin secret
  unauthorized_role: anonymous                  # Fallback role when no auth provided

  jwt:
    type: RS256                   # Algorithm: HS256, RS256, ES256, Ed25519 (default: HS256)
    key: "secret"                 # Raw secret key (HS256)
    key_from_env: JWT_SECRET      # ...or from env var
    jwk_url: https://.../.well-known/jwks.json  # JWKS endpoint (RS256/ES256/Ed25519)
    claims_namespace: https://hasura.io/jwt/claims  # JWT claims namespace
    claims_map:                   # Alternative: map claims from arbitrary JWT paths
      x-hasura-user-id:
        path: $.sub
        default: ""
    audience: my-app              # Expected JWT aud claim
    issuer: https://auth.example.com  # Expected JWT iss claim
    require_exp: true             # Reject JWTs without exp claim (default: true)
    admin_role_is_admin: false    # Treat JWT role=admin as full admin (default: false)

  webhook:
    url: https://auth.example.com/verify  # Auth webhook URL
    url_from_env: AUTH_WEBHOOK_URL         # ...or from env var
    mode: GET                              # HTTP method: GET or POST (default: GET)
    forward_headers: true                  # Forward client headers to webhook

# ─── Databases ───────────────────────────────────────────────────────────────
databases:
  primary:
    url_from_env: DATABASE_URL    # REQUIRED — env var with connection string
    pool:
      max: 10                     # Max connections (default: 10)
      idle_timeout: 30            # Idle timeout in seconds (default: 30)
      connection_timeout: 5       # Connect timeout in seconds (default: 5)
      max_lifetime: 3600          # Max connection lifetime in seconds (optional)
      allow_exit_on_idle: false   # Allow process exit when pool is idle

  replicas:                       # Read replicas for load distribution
    - url_from_env: DATABASE_REPLICA_URL
      pool:
        max: 40

  session:                        # Dedicated connection for LISTEN/NOTIFY (PgBouncer compat)
    url_from_env: DATABASE_SESSION_URL

  read_your_writes:
    enabled: true                 # Enable read-your-writes consistency (default: false)
    window_seconds: 5             # Route reads to primary for N seconds after write (default: 5)

  prepared_statements:
    enabled: true                 # Enable prepared statement caching
    max_cached: 500               # Max cached statements

  subscription_query_routing: primary  # Route subscription re-queries: primary or replica (default: primary)

# ─── GraphQL ─────────────────────────────────────────────────────────────────
graphql:
  query_depth: 10                 # Max query nesting depth (default: 10)
  max_limit: 100                  # Max rows per query (default: 100)

# ─── REST API ────────────────────────────────────────────────────────────────
# Note: REST config is in api_config.yaml (metadata), not hakkyra.yaml

# ─── Subscriptions ───────────────────────────────────────────────────────────
subscriptions:
  debounce_ms: 50                 # Debounce NOTIFY events before re-query (default: 50)
  keep_alive_ms: 30000            # WebSocket keep-alive ping interval (default: 30000)

# ─── Event Triggers ──────────────────────────────────────────────────────────
event_log:
  retention_days: 7               # Delete delivered events older than N days (default: 7)

event_delivery:
  batch_size: 100                 # Events per delivery batch (default: 100)

event_cleanup:
  schedule: "0 3 * * *"          # Cron schedule for event log cleanup (default: 0 3 * * *)

# ─── Webhooks ────────────────────────────────────────────────────────────────
webhook:
  timeout_ms: 30000               # Webhook request timeout (default: 30000)
  backoff_cap_seconds: 3600       # Max retry backoff in seconds (default: 3600)
  allow_private_urls: false       # Allow webhooks to private IPs — SSRF protection (default: false)
  max_response_bytes: 1048576     # Max webhook response size in bytes (default: 1MB)

# ─── Actions ─────────────────────────────────────────────────────────────────
action_defaults:
  timeout_seconds: 30             # Sync action timeout (default: 30)
  async_retry_limit: 3            # Async action max retries (default: 3)
  async_retry_delay_seconds: 10   # Async action initial retry delay (default: 10)
  async_timeout_seconds: 120      # Async action timeout (default: 120)

# ─── Job Queue ───────────────────────────────────────────────────────────────
job_queue:
  provider: pg-boss               # pg-boss (default) or bullmq (requires Redis)
  connection_string: postgres://...  # Override connection string for pg-boss
  redis:                           # Redis config for BullMQ provider
    url: redis://localhost:6379
    host: localhost
    port: 6379
    password: secret

# ─── Redis (multi-instance subscription fanout) ─────────────────────────────
redis:
  url: redis://localhost:6379     # Redis connection URL
  host: localhost                 # Or host/port/password separately
  port: 6379                     # Default: 6379
  password: secret

# ─── Query Cache ─────────────────────────────────────────────────────────────
query_cache:
  max_size: 1000                  # LRU cache entries for compiled SQL (default: 1000)

# ─── SQL Compilation Tuning ──────────────────────────────────────────────────
sql:
  array_any_threshold: 20         # Switch _in arrays to ANY($N) above this size (default: 20)
  unnest_threshold: 500           # Switch bulk inserts to UNNEST above this size (default: 500)
  batch_chunk_size: 100           # Rows per batch chunk (default: 100)
```

### 2. Metadata directory (Hasura-compatible)

```
metadata/
├── version.yaml
├── databases/
│   ├── databases.yaml
│   └── default/
│       └── tables/
│           ├── tables.yaml
│           ├── public_users.yaml
│           └── public_articles.yaml
├── api_config.yaml          # table aliases, custom queries, REST overrides
├── actions.yaml
├── actions.graphql
├── cron_triggers.yaml
└── inherited_roles.yaml
```

#### Table config example

```yaml
table:
  schema: public
  name: client

object_relationships:
  - name: branch
    using:
      foreign_key_constraint_on: branch_id

array_relationships:
  - name: accounts
    using:
      foreign_key_constraint_on:
        column: client_id
        table:
          schema: public
          name: account

select_permissions:
  - role: client
    permission:
      columns: [id, username, email, status]
      filter:
        id:
          _eq: X-Hasura-User-Id

  - role: backoffice
    permission:
      columns: "*"
      filter: {}
      allow_aggregations: true

insert_permissions:
  - role: backoffice
    permission:
      columns: [username, email, branch_id]
      check:
        branch_id:
          _is_null: false
      set:
        status: active      # preset — cannot be provided by caller, always set to "active"
```

Column presets (`set`) inject values automatically on insert/update. Preset columns cannot be provided by the caller — attempting to do so returns an error. Presets can reference session variables (e.g., `x-hasura-User-Id`) or literal values. InsertInput fields are all optional at the schema level since different roles have different presets and allowed columns; strict per-role validation happens at runtime.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /graphql` | GraphQL endpoint (queries, mutations, subscriptions via WebSocket upgrade) |
| `GET /api/v1/{table}` | List rows with filters, ordering, pagination |
| `GET /api/v1/{table}/:id` | Get row by primary key |
| `POST /api/v1/{table}` | Insert row |
| `PATCH /api/v1/{table}/:id` | Update row |
| `DELETE /api/v1/{table}/:id` | Delete row |
| `GET /openapi.json` | OpenAPI 3.1 specification |
| `GET /llm-api.json` | LLM-friendly compact API description |
| `GET /sdl` | GraphQL SDL with descriptions |
| `GET /healthz` | Health check |
| `GET /readyz` | Readiness check |
| `POST /v1/events/invoke/:trigger` | Manually invoke an event trigger (admin only) |

### REST Filtering

Query parameters use PostgREST-style syntax:

```
GET /api/v1/users?status=eq.active&created_at=gte.2024-01-01&order=created_at.desc&limit=20
```

| Filter | SQL Equivalent |
|--------|---------------|
| `column=eq.value` | `column = value` |
| `column=neq.value` | `column <> value` |
| `column=gt.value` | `column > value` |
| `column=gte.value` | `column >= value` |
| `column=lt.value` | `column < value` |
| `column=lte.value` | `column <= value` |
| `column=in.(a,b,c)` | `column IN (a, b, c)` |
| `column=like.*pattern*` | `column LIKE '%pattern%'` |
| `column=is.null` | `column IS NULL` |

## Authentication

Hakkyra supports three authentication methods, checked in order:

1. **Admin secret** — `x-hasura-admin-secret` header bypasses all permissions
2. **JWT** — `Authorization: Bearer <token>` with claims in configurable namespace
3. **Webhook** — forward headers to an external auth endpoint

JWT claims follow the Hasura format:

```json
{
  "https://hasura.io/jwt/claims": {
    "x-hasura-default-role": "user",
    "x-hasura-allowed-roles": ["user", "admin"],
    "x-hasura-user-id": "42"
  }
}
```

## Custom Queries

Define SQL-backed operations in `api_config.yaml`:

```yaml
custom_queries:
  - name: userWithStats
    type: query
    sql: |
      SELECT u.id, u.username,
        (SELECT count(*) FROM orders WHERE user_id = u.id) as order_count
      FROM users u WHERE u.id = $1
    params:
      - name: userId
        type: uuid
    returns: UserWithStats
    permissions:
      - role: admin
      - role: user
        filter:
          id:
            _eq: X-Hasura-User-Id
```

## Subscriptions

Real-time GraphQL subscriptions use a **LISTEN/NOTIFY + re-query + hash-diff** approach:

1. PostgreSQL triggers fire `NOTIFY` on the `hakkyra_changes` channel when tracked tables change (INSERT/UPDATE/DELETE)
2. The server receives the notification via `pg-listen` and re-runs affected subscription queries
3. Results are hashed (SHA-256) and only pushed to the client if the data actually changed

### Multi-Instance Fanout (Redis Pub/Sub)

When running multiple Hakkyra instances behind a load balancer, only one instance receives each PostgreSQL notification. To solve this, an optional **Redis pub/sub fanout bridge** republishes notifications to the `hakkyra:sub:changes` Redis channel so all instances can re-query their local subscription clients.

Each instance stamps messages with a UUID so it skips its own messages (already handled locally). Requires `ioredis` as an optional dependency — without Redis configured, subscriptions work in single-instance mode.

### Query Routing

By default, subscription re-queries run against the **primary** database to avoid stale reads from replication lag. Since LISTEN/NOTIFY fires on the primary, a replica may not have replicated the change by the time the re-query executes, causing the update to be silently missed.

This is configurable via `databases.subscription_query_routing`:

```yaml
databases:
  subscription_query_routing: primary  # default — correct, hits primary
  # subscription_query_routing: replica  # routes to read replicas
```

Set to `replica` if your replication lag is consistently low and you want to offload subscription queries from the primary.

## Event Triggers

Capture database changes and deliver webhooks with at-least-once semantics:

```yaml
# In table config YAML
event_triggers:
  - name: user_created
    definition:
      insert:
        columns: "*"
    webhook: '{{CORE_SERVER_URL}}hooks/user-created'
    retry_conf:
      num_retries: 5
      retry_interval_seconds: 15
      timeout_seconds: 60
    headers:
      - name: x-webhook-secret
        value_from_env: WEBHOOK_SECRET
```

Events follow the **transactional outbox pattern**: PG triggers write to `hakkyra.event_log` in the same transaction as the data change, then the job queue delivers the webhook with exponential backoff retry.

This means events are captured reliably even if the server is down — the PG trigger and `event_log` insert happen entirely within PostgreSQL. When the server starts back up, it catches up on all pending events automatically. Delivery is at-least-once: events are marked `processing` before webhook delivery and updated to `delivered` or retried on failure.

The job queue backend is pluggable — pg-boss (default, PostgreSQL-based) or BullMQ (optional, requires Redis). See [Job Queue](#job-queue) for configuration.

## Cron Triggers

Schedule recurring webhook invocations:

```yaml
# cron_triggers.yaml
- name: daily_cleanup
  webhook: '{{CORE_SERVER_URL}}cron/cleanup'
  schedule: "0 3 * * *"
  payload:
    action: cleanup
  retry_conf:
    num_retries: 3
    retry_interval_seconds: 60
```

## Actions

Proxy GraphQL mutations/queries to external HTTP handlers (Hasura-compatible):

```yaml
# actions.yaml
actions:
  - name: updateLimit
    definition:
      kind: synchronous
      handler: '{{CORE_SERVER_INTERNAL_URL}}actions/updateLimit'
      forward_client_headers: true
    permissions:
      - role: player
```

Action handler URLs support `{{ENV_VAR}}` template interpolation — the same syntax Hasura uses. Actions support:

- **Synchronous** — proxy request and return response inline
- **Asynchronous** — return immediately, deliver result via webhook later
- **Request/response transforms** — template-based URL, body, and header rewriting
- **Action relationships** — map action output fields to database table relationships

## CLI

```
hakkyra start [options]     # production start (default command)
hakkyra dev [options]       # dev mode with hot reload
hakkyra init                # scaffold project with example config

Options:
  --port <number>      Server port (default: 3000)
  --host <string>      Server host (default: 0.0.0.0)
  --config <path>      Path to hakkyra.yaml (default: ./hakkyra.yaml)
  --metadata <path>    Path to metadata directory (default: ./metadata)
  --dev                Enable dev mode with config hot reload
  --help, -h           Show help
```

## Unsupported Hasura Features

Hakkyra reads Hasura-compatible YAML metadata but does not implement all Hasura features. The config loader **rejects** metadata containing unsupported features with a clear error message, rather than silently ignoring them.

**Not supported by design** (architectural decision):
- **Remote relationships** — Hakkyra connects to a single PostgreSQL database; cross-source joins are out of scope
- **Apollo Federation** — Hakkyra serves a standalone GraphQL API, not a federated subgraph

**Not implemented** (Hasura features Hakkyra does not use):
- Remote schemas, allowlists, API limits, OpenTelemetry, network/TLS config, backend-specific config
- Stored procedures, database customization (table name prefix/suffix, root field namespace)

**Ignored with warning** (present in metadata but has no effect):
- Input validation webhooks (`validate_input` in permissions) — logged as a warning and skipped

If your Hasura metadata export contains any of these, `loadConfig()` will throw listing all unsupported features found. Empty files (e.g., `[]`) are ignored.

## Architecture

```
HTTP/WS ─► Fastify ─► Auth Hook ─► Permission Compiler
                         │
              ┌──────────┴──────────┐
              │    Schema Engine    │
              │  GraphQL  │  REST   │
              └──────┬────┴────┬────┘
                     └────┬────┘
                  SQL Query Compiler
                          │
                 Connection Manager
               ┌──────────┼──────────┐
             Primary    Replica    Replica
```

All queries — GraphQL and REST — compile to a single parameterized SQL statement using `json_build_object` with camelCase keys for response shaping. Relationships are resolved via correlated subqueries, not N+1 queries.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| HTTP Server | Fastify 5 |
| GraphQL | Mercurius (with graphql-jit) |
| WebSocket | graphql-ws protocol |
| JWT | jose |
| PostgreSQL | pg (node-postgres) |
| Job Queue | pg-boss (default) or BullMQ (optional, requires Redis) |
| DB Notifications | pg-listen |
| Redis Pub/Sub | ioredis (optional) |
| Config | js-yaml with `!include` support |

## Development

```bash
npm install
docker compose up -d        # start PostgreSQL 17
npm test                    # run tests (~1200 tests, 36 suites)
npm run typecheck           # type-check without emitting
npm run build               # compile TypeScript
```

## License

MIT
