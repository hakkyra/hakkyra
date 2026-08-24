# Acme Migration Findings (Phase 13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six behavioural differences from Hasura found while migrating the acme deployment (BACKLOG.md Phase 13, P13.1–P13.6).

**Architecture:** Each finding is an independent fix in an existing subsystem: action permission checking (P13.3), Mercurius error formatting (P13.6), event-log schema + delivery (P13.5), aggregate/native-query SQL compilation + CJS scalar patching (P13.2), schema generation enum handling + config (P13.1), and one new module `src/scheduled-events/` (P13.4).

**Tech Stack:** Node.js + TypeScript (ESM), Fastify + Mercurius 16, graphql-js 16, pg, Zod, Vitest against real PostgreSQL 17 (docker-compose).

**Spec:** `BACKLOG.md` lines 1875–1973 ("Phase 13: Acme Migration Findings").

## Global Constraints

- Hasura compatibility is exact-match, no backwards-compat shims (match Hasura's naming, wire format, defaults).
- `graphql.pg_enums_as_scalars` defaults to **true** (Hasura-compatible); GraphQL enum mode is the opt-out.
- New event_log columns need `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations (existing deployments have the table already).
- Run tests with `npm test -- <file>` (vitest); PG must be up via `docker compose up -d`.
- All raw YAML Zod schemas are `.strict()` — any new config field must be declared in `src/config/schemas.ts` AND `src/config/schemas-internal.ts` with `.describe()` (docs are generated from these).
- Commit after each task; message style: `fix:`/`feat:` one-liner like recent history.

---

### Task 1: P13.3 — Action permissions expand inherited roles

**Files:**
- Modify: `src/actions/permissions.ts`
- Modify: `src/actions/schema.ts:664,707,754,877` (pass `context.inheritedRoles`)
- Modify: `src/actions/rest.ts` (add `inheritedRoles` to deps, pass at `:93`)
- Modify: `src/server/jobs.ts` (pass `config.inheritedRoles` to `registerAsyncActionStatusRoute`)
- Test: `test/actions.test.ts` (add unit describe block; file already imports `checkActionPermission` or add import)

**Interfaces:**
- Produces: `checkActionPermission(action: ActionConfig, session: SessionVariables, inheritedRoles?: Record<string, string[]>): boolean`
- Consumes: `ResolverContext.inheritedRoles: Record<string, string[]>` (already exists, `src/schema/resolvers/helpers.ts:56`)

- [x] **Step 1: Write failing unit tests** in `test/actions.test.ts` (new top-level describe; use existing imports/fixtures style):

```ts
describe('checkActionPermission inherited roles', () => {
  const action = {
    name: 'campaignQuery',
    permissions: [{ role: 'campaign' }],
  } as ActionConfig;
  const inheritedRoles = {
    backoffice_administrator: ['backoffice', 'campaign', 'administrator', 'manager'],
  };
  const session = (roles: string[]): SessionVariables => ({
    role: roles[0], allowedRoles: roles, isAdmin: false, vars: {},
  } as unknown as SessionVariables);

  it('allows a session whose inherited role includes a permitted constituent', () => {
    expect(checkActionPermission(action, session(['backoffice_administrator', 'backoffice']), inheritedRoles)).toBe(true);
  });

  it('denies when no allowed role or constituent matches', () => {
    expect(checkActionPermission(action, session(['backoffice']), inheritedRoles)).toBe(false);
  });

  it('still works without inheritedRoles argument', () => {
    expect(checkActionPermission(action, session(['campaign']))).toBe(true);
  });
});
```

Adjust the `SessionVariables` literal to the real shape (see `src/types.ts`) so it type-checks.

- [x] **Step 2: Run** `npm test -- actions` → new tests FAIL (extra arg ignored, first test returns false).

- [x] **Step 3: Implement** in `src/actions/permissions.ts`:

```ts
export function checkActionPermission(
  action: ActionConfig,
  session: SessionVariables,
  inheritedRoles?: Record<string, string[]>,
): boolean {
  if (session.isAdmin) return true;
  if (!action.permissions || action.permissions.length === 0) return false;
  // Expand inherited roles: a session carrying an inherited role is granted
  // any action permitted to one of its constituent roles (Hasura-compatible).
  const roles = new Set(session.allowedRoles);
  if (inheritedRoles) {
    for (const role of session.allowedRoles) {
      for (const constituent of inheritedRoles[role] ?? []) roles.add(constituent);
    }
  }
  return action.permissions.some((p) => roles.has(p.role));
}
```

- [x] **Step 4: Thread the argument through callers.**
  - `src/actions/schema.ts`: all four call sites become `checkActionPermission(action, context.auth, context.inheritedRoles)` (at :877 the context variable may be named differently — same object).
  - `src/actions/rest.ts`: add `inheritedRoles?: Record<string, string[]>` to `AsyncActionStatusDeps`; call becomes `checkActionPermission(actionConfig, session, deps.inheritedRoles)`.
  - `src/server/jobs.ts`: where `registerAsyncActionStatusRoute` is called, add `inheritedRoles: config.inheritedRoles`.

- [x] **Step 5: Run** `npm test -- actions async-actions` → PASS. Run `npx tsc --noEmit` → clean.

- [x] **Step 6: Commit** `fix: expand inherited roles in action permission checks`

---

### Task 2: P13.6 — Hasura-shaped GraphQL errors (no top-level locations/path)

**Files:**
- Modify: `src/server.ts:224-252` (add `errorFormatter` to the mercurius register options)
- Test: `test/actions.test.ts` (or wherever a sync action E2E error is already asserted — grep `ACTION_HANDLER_ERROR` / `Not authorized to execute action` in tests)

**Interfaces:**
- Produces: GraphQL error entries shaped `{ message, extensions? }` — never `locations`/`path` — for ALL errors on the `/graphql` endpoint (Hasura never emits top-level locations/path).

- [x] **Step 1: Check existing expectations:** `grep -rn "locations\|\.path" test/*.test.ts | grep -i error` — update any test asserting top-level `locations`/`path` on GraphQL errors to assert their absence instead (there should be few or none).

- [x] **Step 2: Write failing E2E test** in the file that already runs sync-action error scenarios (extend the existing failing-action test):

```ts
const body = res.json();
expect(body.errors[0].message).toBeDefined();
expect(body.errors[0]).not.toHaveProperty('locations');
expect(body.errors[0]).not.toHaveProperty('path');
expect(body.errors[0].extensions).toBeDefined();
```

- [x] **Step 3: Run** the test file → FAIL (locations/path present).

- [x] **Step 4: Implement** in `src/server.ts` mercurius options:

```ts
errorFormatter: (result, context) => {
  const formatted = mercurius.defaultErrorFormatter(result, context as Parameters<typeof mercurius.defaultErrorFormatter>[1]);
  if (formatted.response.errors) {
    // Hasura error shape: { message, extensions } only — no locations/path.
    formatted.response.errors = formatted.response.errors.map((err) => {
      const clean: { message: string; extensions?: unknown } = { message: err.message };
      const ext = (err as { extensions?: Record<string, unknown> }).extensions;
      if (ext && Object.keys(ext).length > 0) clean.extensions = ext;
      return clean;
    }) as typeof formatted.response.errors;
  }
  return formatted;
},
```

- [x] **Step 5: Run** `npm test -- actions e2e security` → PASS (fix any other tests asserting the old shape). `npx tsc --noEmit` clean.

- [x] **Step 6: Commit** `fix: strip locations/path from GraphQL errors to match Hasura error shape`

---

### Task 3: P13.5 — Store webhook response bodies in event_log

**Files:**
- Modify: `src/events/schema.ts` (add `response_body TEXT` + migration statements)
- Modify: `src/events/delivery.ts` (store `result.body` in onSuccess/onFailure)
- Test: `test/events.test.ts`

**Interfaces:**
- Produces: `hakkyra.event_log.response_body TEXT` column; `migrateEventLogSQL(schemaName): string` exported from `src/events/schema.ts`.
- Consumes: `WebhookDeliveryResult.body?: string` (already exists, `src/shared/webhook.ts:29`).

- [x] **Step 1: Write failing test** in `test/events.test.ts` — in the delivery describe block, after a successful delivery assertion, query the event_log row:

```ts
const row = await pool.query(
  `SELECT response_body, response_status FROM hakkyra.event_log WHERE trigger_name = $1 ORDER BY created_at DESC LIMIT 1`,
  ['test_invoice_created'],
);
expect(row.rows[0].response_status).toBe(200);
expect(row.rows[0].response_body).toBeTruthy(); // mock server responds with JSON body
```

Also set a distinctive mock response body first (`webhookServer.responseBody = { ok: true, handled: 'invoice' }` — see MockWebhookServer setter) and assert `JSON.parse(row.rows[0].response_body)` deep-equals it. Add a failure-path test: set `responseCode = 500`, deliver, assert `response_body` stored on the failed attempt too.

- [x] **Step 2: Run** `npm test -- events` → FAIL (column does not exist).

- [x] **Step 3: Implement.**
  - `src/events/schema.ts`: add `response_body TEXT` to `createEventLogSQL`, and add:

```ts
/**
 * Idempotent migrations for columns added after the table was first created.
 * CREATE TABLE IF NOT EXISTS does not add new columns to existing tables.
 */
export function migrateEventLogSQL(schemaName: string): string {
  return `
ALTER TABLE ${quoteIdent(schemaName)}.event_log ADD COLUMN IF NOT EXISTS delivered BOOLEAN DEFAULT false;
ALTER TABLE ${quoteIdent(schemaName)}.event_log ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE ${quoteIdent(schemaName)}.event_log ADD COLUMN IF NOT EXISTS response_body TEXT;
`;
}
```

  Call it from `ensureEventSchema` after `createEventLogSQL`.
  - `src/events/delivery.ts` onSuccess:

```ts
await pool.query(
  `UPDATE ${quoteIdent(schemaName)}.event_log SET status = 'delivered', delivered = true, delivered_at = now(),
   response_status = $2, response_body = $3 WHERE id = $1`,
  [eventId, result.statusCode, result.body ?? null],
);
```

  onFailure: add `response_body = $6` with `result.body ?? null` appended to the params array (renumber placeholders carefully — current SQL uses $1–$5).

- [x] **Step 4: Run** `npm test -- events` → PASS.

- [x] **Step 5: Commit** `feat: retain webhook response bodies in event_log (response_body column)`

---

### Task 4: P13.2 — stringify_numeric_types for aggregates and native queries

**Files:**
- Modify: `src/introspection/type-map.ts` (export `isStringifyNumericEnabled()`)
- Modify: `src/sql/select.ts` (cast aggregate outputs; extend `AggregateComputedFieldRef`)
- Modify: `src/schema/resolve-info.ts` (populate `returnType` on aggregate computed-field refs — it already resolves `functionInfo` for computed fields)
- Modify: `src/server/schema.ts` (`applyStringifyNumericSerialization` in `buildCjsSchema`)
- Modify: `src/schema/native-queries.ts` (stringify projection wrapper)
- Test: new `test/stringify-numeric.test.ts` (+ additions to `test/sql-compiler.test.ts` style; reuse its harness)

**Interfaces:**
- Produces: `isStringifyNumericEnabled(): boolean` from type-map; `AggregateComputedFieldRef.returnType?: string`.
- Consumes: `shouldCastToText(udtName)`, `configureStringifyNumericTypes(enabled)` (type-map), `compileSelectAggregate` (select.ts), `buildCjsSchema` (server/schema.ts).

Background (why each piece): aggregate JSON is built in SQL, so numeric aggregate results arrive as JSON numbers regardless of the pg driver's string parsing; Hasura with `stringify_numeric_types: true` casts them to text by the aggregate's *result* type (`count` → int8 → `"0"`, `sum(numeric)` → `"3000"`). Fields declared with pass-through custom scalars (`Bigint`, `Numeric`) survive graphql-js serialization; `count` (`Int!`) and `Float`-typed fields would be coerced back to numbers by the built-in scalars, so the CJS built-ins get a serialize patch (same precedent as `applyStringCoercion` which already mutates the CJS `String` scalar). Native queries return rows via `json_agg`/`row_to_json` in subscriptions and raw rows in queries; a projection wrapper casts stringify-typed logical-model fields to text.

- [x] **Step 1: Write failing SQL-compiler tests** in `test/stringify-numeric.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compileSelectAggregate } from '../src/sql/select.js';
import { configureStringifyNumericTypes } from '../src/introspection/type-map.js';
// build a TableInfo with columns: id int4, total numeric, big int8, ratio float8
// (copy the minimal TableInfo builder pattern from test/sql-compiler.test.ts)

afterEach(() => configureStringifyNumericTypes(false));

it('casts count and numeric aggregates to text when stringify is enabled', () => {
  configureStringifyNumericTypes(true);
  const q = compileSelectAggregate({ table, aggregate: { count: {}, sum: ['total', 'id'], avg: ['id'], min: ['total'], max: ['big'] }, session, permission: null });
  expect(q.sql).toContain(`(count(*))::text`);
  expect(q.sql).toContain(`(sum("t0"."total"))::text`);      // numeric → numeric
  expect(q.sql).toContain(`(sum("t0"."id"))::text`);          // int4 → int8
  expect(q.sql).toContain(`(avg("t0"."id"))::text`);          // avg → numeric
  expect(q.sql).toContain(`(min("t0"."total"))::text`);       // min keeps column type numeric
  expect(q.sql).toContain(`(max("t0"."big"))::text`);         // int8
});

it('does not cast when stringify is disabled', () => {
  const q = compileSelectAggregate({ table, aggregate: { count: {}, sum: ['total'] }, session, permission: null });
  expect(q.sql).toContain(`count(*)`);
  expect(q.sql).not.toContain('::text');
});

it('does not cast min/max of int4 (not a stringified type)', () => {
  configureStringifyNumericTypes(true);
  const q = compileSelectAggregate({ table, aggregate: { min: ['id'] }, session, permission: null });
  expect(q.sql).toContain(`'id', min("t0"."id")`);
});
```

Match the actual `SelectAggregateOptions` shape from select.ts (look at existing aggregate tests in `test/sql-compiler.test.ts` / `test/group-by.test.ts` for the exact options and session fixture).

- [x] **Step 2: Run** `npm test -- stringify-numeric` → FAIL.

- [x] **Step 3: Implement SQL casting** in `src/sql/select.ts`.
  - Export from `src/introspection/type-map.ts`:

```ts
/** True when stringify_numeric_types is enabled (configureStringifyNumericTypes(true)). */
export function isStringifyNumericEnabled(): boolean {
  return stringifyNumericOverrides !== null;
}
```

  - In select.ts add (near the aggregate section):

```ts
/**
 * PG result type of an aggregate function applied to a column type.
 * Used to decide text-casting under stringify_numeric_types: Hasura
 * stringifies by the aggregate RESULT type (count → int8, sum(int4) → int8,
 * avg → numeric/float8), not the source column type.
 */
function aggregateResultPgType(fn: string, udtName: string): string {
  const base = udtName.startsWith('_') ? udtName.slice(1) : udtName;
  switch (fn) {
    case 'count':
      return 'int8';
    case 'sum':
      if (['int2', 'smallint', 'int4', 'integer', 'serial', 'serial4'].includes(base)) return 'int8';
      if (['int8', 'bigint', 'bigserial', 'serial8'].includes(base)) return 'numeric';
      return base;
    case 'avg':
    case 'stddev':
    case 'stddevPop':
    case 'stddevSamp':
    case 'variance':
    case 'varPop':
    case 'varSamp':
      if (['float4', 'real', 'float8', 'double precision'].includes(base)) return 'float8';
      return 'numeric';
    default: // min/max keep the column type
      return base;
  }
}

function maybeCastAggregate(expr: string, fn: string, udtName: string | undefined): string {
  if (!udtName) return expr;
  return shouldCastToText(aggregateResultPgType(fn, udtName)) ? `(${expr})::text` : expr;
}
```

  - Apply at every aggregate output site, using the column lookup maps already in scope:
    1. `compileSelectAggregate` flat path: count (`maybeCastAggregate('count(...)', 'count', 'int8')` — including the column-list variant), the sum/avg/min/max loop (`aggColumnLookup.get(c)?.udtName`), and the STAT_AGG_MAP loop.
    2. `compileSelectAggregate` GROUP BY inner query: same casts on the aliased inner expressions (`count(*) AS "_count_"` etc. — cast the function call, keep the alias).
    3. `buildAggregateRelationshipSubquery` (nested `{rel}Aggregate`): count, sum/avg/min/max loop, STAT_AGG_MAP_REL loop, using its `remoteTable.columns` lookup (`aggColumnLookup` at select.ts:794).
  - Computed-field aggregates: add `returnType?: string` to `AggregateComputedFieldRef`; in `src/schema/resolve-info.ts` where these refs are constructed, set `returnType: fn.returnType` from the resolved `FunctionInfo`. In the aggregate loops, `maybeCastAggregate(funcCall, fn, cf.returnType)`.

- [x] **Step 4: Run** `npm test -- stringify-numeric sql-compiler group-by nested-aggregate statistical-aggregates` → new tests PASS, no regressions (stringify defaults off, so existing tests unchanged).

- [x] **Step 5: Patch CJS Int/Float serialization** in `src/server/schema.ts`. Add and call from `buildCjsSchema` (after `applyStringCoercion`):

```ts
/**
 * Hasura compatibility: with stringify_numeric_types enabled, aggregate
 * results are text-cast in SQL (count → "0"). The built-in Int/Float
 * serializers would coerce those strings back to numbers, so let string
 * values pass through untouched. Gated at call time so hot-reload with the
 * setting toggled works (built-ins are shared module instances).
 */
function applyStringifyNumericSerialization(
  cjsSchema: GraphQLSchema,
  _cjsGraphql: typeof import('graphql'),
): void {
  const typeMap = cjsSchema.getTypeMap();
  for (const name of ['Int', 'Float']) {
    const scalar = typeMap[name] as (import('graphql').GraphQLScalarType & { __hakkyraStringifyPatched?: boolean }) | undefined;
    if (!scalar || scalar.__hakkyraStringifyPatched) continue;
    const orig = scalar.serialize.bind(scalar);
    scalar.serialize = (value: unknown) =>
      isStringifyNumericEnabled() && typeof value === 'string' && value !== '' ? value : orig(value);
    scalar.__hakkyraStringifyPatched = true;
  }
}
```

Import `isStringifyNumericEnabled` from `../introspection/type-map.js`.

- [x] **Step 6: Native query projection** in `src/schema/native-queries.ts`:

```ts
import { quoteIdentifier } from '../sql/utils.js';
import { shouldCastToText, isStringifyNumericEnabled } from '../introspection/type-map.js';

/** Logical-model type spellings → PG udt names understood by shouldCastToText. */
const NQ_PG_TYPE_ALIASES: Record<string, string> = {
  int: 'int4', integer: 'int4', bigint: 'int8', decimal: 'numeric',
  float: 'float8', double: 'float8', 'double precision': 'float8',
};

/**
 * Build a SELECT list that casts stringify-numeric fields to text, or null
 * when stringify is off / no field needs casting. Checked at request time so
 * hot reload with the setting toggled works.
 */
function buildStringifyProjection(model: LogicalModel): string | null {
  if (!isStringifyNumericEnabled()) return null;
  let needsCast = false;
  const cols = model.fields.map((f) => {
    const t = f.type.toLowerCase();
    const udt = NQ_PG_TYPE_ALIASES[t] ?? t;
    if (shouldCastToText(udt)) {
      needsCast = true;
      return `(${quoteIdentifier(f.name)})::text AS ${quoteIdentifier(f.name)}`;
    }
    return quoteIdentifier(f.name);
  });
  return needsCast ? cols.join(', ') : null;
}

function applyStringifyProjection(sql: string, model: LogicalModel): string {
  const proj = buildStringifyProjection(model);
  return proj ? `SELECT ${proj} FROM (${sql}) AS "__nq_str"` : sql;
}
```

Apply `applyStringifyProjection(finalSQL, logicalModel)` as the OUTERMOST wrap in `makeNativeQueryResolver` (both the permission branch after the filter wrap, and the admin branch), and in `makeNativeQuerySubscriptionSubscribe` wrap the inner SQL *before* `wrapForSubscription` (cast must sit inside `row_to_json`). Note: applied after permission filtering so filters still compare native types.

- [x] **Step 7: Serialization tests** (same test file): build a tiny schema through `generateSchema` + `buildCjsSchema` with stringify on, execute an aggregate query with a stubbed resolver — OR simpler unit test: import `buildCjsSchema`, get `Int` from the cjs schema type map, assert `serialize('0') === '0'` with `configureStringifyNumericTypes(true)` and `serialize('7') === 7`-style coercion when off (`=== 7` number via orig). Add a native-query unit test asserting `applyStringifyProjection` output SQL (export it or test via the schema-level SDL/resolver if not exported — exporting the two helpers for tests is fine).

- [x] **Step 8: Run** `npm test` (full suite) → PASS. `npx tsc --noEmit` clean.

- [x] **Step 9: Commit** `fix: apply stringify_numeric_types to aggregates, count, and native query fields`

---

### Task 5: P13.1 — `graphql.pg_enums_as_scalars` (default true)

**Files:**
- Modify: `src/config/schemas.ts:760-768` (raw `graphql` section: add `pg_enums_as_scalars`)
- Modify: `src/config/schemas-internal.ts:536-540` (internal `graphql`: add `pgEnumsAsScalars` default true; update the `.default({...})` literal)
- Modify: `src/config/loader.ts:372` region (map `pg_enums_as_scalars`)
- Modify: `src/schema/scalars.ts` (add `makeOpaqueEnumScalar`)
- Modify: `src/schema/generator.ts` (buildEnumTypes gains scalar mode; `GenerateSchemaOptions.pgEnumsAsScalars`)
- Modify: type widening in `src/schema/filters.ts`, `src/schema/inputs.ts`, `src/schema/type-builder.ts` (enumTypes map value type)
- Modify: `src/server.ts:127,319`, `src/server/schema.ts:254`, `src/server/routes.ts:211` (pass `pgEnumsAsScalars: config.graphql.pgEnumsAsScalars`)
- Modify: `test/fixtures/hakkyra.yaml` (add `graphql: { pg_enums_as_scalars: false }` to keep the existing enum-mode suite green)
- Modify: `README.md` (document the flag where PG enum → GraphQL enum behavior is described)
- Test: new `test/pg-enum-scalars.test.ts`; update direct `generateSchema` tests that assert enum behavior to pass `pgEnumsAsScalars: false`

**Interfaces:**
- Produces: `type EnumLikeType = GraphQLEnumType | GraphQLScalarType` (exported from generator.ts); `makeOpaqueEnumScalar(name: string, description: string): GraphQLScalarType`; `GenerateSchemaOptions.pgEnumsAsScalars?: boolean` (undefined ⇒ true); internal config `config.graphql.pgEnumsAsScalars: boolean` (default true).
- Consumes: `pgEnumToGraphQLName`, existing `buildEnumTypes` pipeline, `tables[].isEnum` (table-based enums keep their `${table.name}_enum` EnumInfo entries and MUST remain real GraphQL enums — that is Hasura's enum-table feature).

Behavior in scalar mode (the new default): each native PG enum becomes an opaque pass-through scalar with the SAME GraphQL name it has today (`payment_state` → `PaymentState`), accepting string literals and returning raw DB values (`'created'`, not `'CREATED'`). Comparison exps keep their names/operators but are typed with the scalar. Table-based enums (`is_enum: true`) are unaffected in both modes.

- [x] **Step 1: Config schema tests first.** In the Zod schema test file (the suite named "Zod schemas" — `grep -rln "pg_enums_as_scalars\|maxBatchSize" test/` to find it; it lives where `graphql` section defaults are asserted): add cases asserting (a) internal default `graphql.pgEnumsAsScalars === true`, (b) raw schema accepts `graphql: { pg_enums_as_scalars: false }`, (c) strict rejection of a typo field stays intact. Run → FAIL.

- [x] **Step 2: Implement config plumbing.**
  - schemas.ts `graphql` object: `pg_enums_as_scalars: z.boolean().optional().describe('Expose PostgreSQL enums as opaque String scalars like Hasura (true, default) or as GraphQL enum types (false)'),`
  - schemas-internal.ts: `pgEnumsAsScalars: z.boolean().default(true).describe('Expose PG enums as opaque string scalars (Hasura-compatible)'),` and add `pgEnumsAsScalars: true` to the section's `.default({...})` literal.
  - loader.ts (graphql mapping block at :372): `pgEnumsAsScalars: serverConfig?.graphql?.pg_enums_as_scalars,`
  - Run the schema tests → PASS.

- [x] **Step 3: Write failing schema-level tests** `test/pg-enum-scalars.test.ts` (pure generateSchema, follow `test/schema.test.ts` model-building pattern — a model with one native enum `order_status` values `['created','pending']`, a table using it, and one `is_enum` table enum entry `priority_enum`):

```ts
const schema = generateSchema(model); // default: scalar mode
const t = schema.getType('OrderStatus');
expect(t).toBeInstanceOf(GraphQLScalarType);
const tableEnum = schema.getType('PriorityEnum');
expect(tableEnum).toBeInstanceOf(GraphQLEnumType); // table-based enums stay enums

// literal + value passthrough
const scalar = t as GraphQLScalarType;
expect(scalar.parseLiteral({ kind: Kind.STRING, value: 'created' } as never)).toBe('created');
expect(scalar.serialize('created')).toBe('created'); // raw DB value, not CREATED

// comparison exp typed with the scalar
const cmp = schema.getType('OrderStatusComparisonExp') as GraphQLInputObjectType;
expect(cmp.getFields()['_eq'].type).toBe(scalar);

// opt-out restores enum mode
const enumSchema = generateSchema(model, { pgEnumsAsScalars: false });
expect(enumSchema.getType('OrderStatus')).toBeInstanceOf(GraphQLEnumType);
```

Check the actual comparison-exp naming for enums in filters.ts and use it. Run → FAIL.

- [x] **Step 4: Implement generator changes.**
  - scalars.ts:

```ts
/**
 * Opaque string scalar standing in for a PG enum type (Hasura-compatible:
 * native PG enums are exposed as text-like scalars, not GraphQL enums).
 * Accepts string literals; ENUM literals are also accepted for leniency.
 */
export function makeOpaqueEnumScalar(name: string, description: string): GraphQLScalarType {
  const toStr = (value: unknown): string => String(value);
  return new GraphQLScalarType({
    name,
    description,
    serialize: toStr as GraphQLScalarSerializer<string>,
    parseValue: toStr as GraphQLScalarValueParser<string>,
    parseLiteral(ast) {
      if (ast.kind !== Kind.STRING && ast.kind !== Kind.ENUM) {
        throw new TypeError(`${name} must be a string, got: ${ast.kind}`);
      }
      return (ast as { value: string }).value;
    },
  });
}
```

  - generator.ts: `export type EnumLikeType = GraphQLEnumType | GraphQLScalarType;` Change `buildEnumTypes(enums, pgEnumsAsScalars: boolean, tableEnumRawNames: Set<string>): Map<string, EnumLikeType>` — native enums (`!tableEnumRawNames.has(enumInfo.name)`) in scalar mode get `makeOpaqueEnumScalar(name, ...)`; everything else keeps the existing GraphQLEnumType build. In `generateSchema`: compute `const tableEnumRawNames = new Set(tables.filter((t) => t.isEnum).map((t) => `${t.name}_enum`));` before Step 1 and call `buildEnumTypes(enums, options?.pgEnumsAsScalars ?? true, tableEnumRawNames)`. Add `pgEnumsAsScalars?: boolean` to `GenerateSchemaOptions` with a doc comment stating the default (true).
  - Widen `Map<string, GraphQLEnumType>` → `Map<string, EnumLikeType>` in every signature that receives `enumTypes` (`buildFilterTypes` in filters.ts, `buildMutationInputTypes`/`buildStreamCursorTypes` in inputs.ts, `buildObjectType` in type-builder.ts, and any `resolveOutputType(name, isList, enumTypes)` helpers). Where a value is used as input/output type, `GraphQLScalarType` is already valid — use the existing `asInputType`/`asOutputType` helpers from scalars.ts where TS needs the nudge. Run `npx tsc --noEmit` and fix each reported site — the changes are type-level only; do not change enum-mode runtime behavior.
  - Comparison-exp building for enums in filters.ts: it keys off the enum type — make sure scalar-mode enums still get their `{Name}ComparisonExp` with the same operator fields, typed with the scalar (the existing code path should work once types are widened; verify the test from Step 3 passes).
  - Pass the option at all four generateSchema call sites (server.ts:127 and :319, server/schema.ts:254, server/routes.ts:211): `pgEnumsAsScalars: config.graphql.pgEnumsAsScalars` (in server/routes.ts and server/schema.ts, `config` is already in scope).

- [x] **Step 5: Keep the existing suite green.**
  - `test/fixtures/hakkyra.yaml`: add top-level

```yaml
graphql:
  pg_enums_as_scalars: false   # test suite exercises Hakkyra's GraphQL-enum mode
```

  - Direct `generateSchema` callers in tests that assert enum behavior for native PG enums (grep `GraphQLEnumType\|_ENUM\|toUpperCase` in `test/schema.test.ts`, `test/enum-comparison-ordering.test.ts`, `test/constraint-enum.test.ts`, others): pass `{ pgEnumsAsScalars: false }` (or extend their existing options object).
  - Run `npm test` → full suite PASS.

- [x] **Step 6: E2E scalar-mode test** (extend `test/pg-enum-scalars.test.ts`): boot a real server the way `test/e2e.test.ts` does, but with a temp copy of `test/fixtures/hakkyra.yaml` with the `graphql:` block removed (write it to a tmp dir in beforeAll; pass its path as configPath). Against a fixture table with a native PG enum column (find one in `test/fixtures/init.sql` — the fixtures have 5 PG enums):
  - mutation with **inline** literal `_set: { <enumField>: "<raw_db_value>" }` succeeds (this is the exact break: `Enum "FunctionStatus" cannot represent non-enum value`),
  - query returns the raw lowercase DB value,
  - `where: { <enumField>: { _eq: "<raw_db_value>" } }` inline literal filters correctly,
  - the same operations through variables also work.
  Run → PASS.

- [x] **Step 7: README** — update the section describing PG enum handling: scalar mode is the default (Hasura-compatible); `graphql.pg_enums_as_scalars: false` opts into GraphQL enum types (documented as the recommended greenfield setting).

- [x] **Step 8: Run** `npm test` full suite once more; `npx tsc --noEmit`. Commit `feat: pg_enums_as_scalars mode — expose PG enums as opaque scalars like Hasura (default)`

---

### Task 6: P13.4 — One-off scheduled events

**Files:**
- Create: `src/scheduled-events/schema.ts` (DDL)
- Create: `src/scheduled-events/delivery.ts` (poller + delivery + retry)
- Create: `src/scheduled-events/manager.ts` (ServiceManager wrapper)
- Create: `src/scheduled-events/api.ts` (`POST /v1/metadata` RPC)
- Create: `src/scheduled-events/index.ts` (re-exports)
- Modify: `src/config/schemas.ts` (raw `scheduled_events` section), `src/config/schemas-internal.ts` (`scheduledEvents` defaults), `src/config/loader.ts` (mapping)
- Modify: `src/server/jobs.ts` (init/return the manager — NOT gated on jobQueue), `src/server.ts` (register API routes; stop manager in shutdown)
- Test: `test/scheduled-events.test.ts`

**Interfaces:**
- Produces: tables `{schema}.scheduled_events` and `{schema}.scheduled_event_invocations` (Hasura `hdb_scheduled_events`-compatible column names so acme's direct INSERT needs only a table-name change); `createScheduledEventManager(deps): ServiceManager`; `registerScheduledEventRoutes(server, { pool, schemaName })`; config `config.scheduledEvents: { pollIntervalMs: number; batchSize: number }` (defaults 10000 / 100).
- Consumes: `deliverWebhook`, `resolveWebhookUrl`, `resolveWebhookHeaders` (`src/shared/webhook.ts`), `ServiceManager` (`src/shared/service-manager.ts` — check its exact shape: init/stop), `quoteIdentifier`.

DDL (schema.ts, mirroring Hasura's hdb_catalog names; status lifecycle `scheduled → locked → delivered | error`, with stale-lock reclaim):

```sql
CREATE TABLE IF NOT EXISTS {s}.scheduled_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_conf TEXT NOT NULL,
  scheduled_time TIMESTAMPTZ NOT NULL,
  retry_conf JSONB,
  payload JSONB,
  header_conf JSONB,
  status TEXT NOT NULL DEFAULT 'scheduled',
  tries INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_retry_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  comment TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_events_due ON {s}.scheduled_events (status, scheduled_time);
CREATE TABLE IF NOT EXISTS {s}.scheduled_event_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES {s}.scheduled_events(id) ON DELETE CASCADE,
  status INTEGER,
  request JSONB,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`retry_conf` JSON uses Hasura's keys: `{ num_retries?: number (default 0), retry_interval_seconds?: number (default 10), timeout_seconds?: number (default 60) }`. `header_conf` is `[{ name, value? , value_from_env? }]`. `webhook_conf` may be a literal URL or `{{ENV_VAR}}` template (resolve like other webhooks).

Delivery loop (delivery.ts):
1. Poll every `pollIntervalMs`. Claim due events:

```sql
WITH due AS (
  SELECT id FROM {s}.scheduled_events
  WHERE (status = 'scheduled' AND scheduled_time <= now()
         AND (next_retry_at IS NULL OR next_retry_at <= now()))
     OR (status = 'locked' AND locked_at < now() - interval '300 seconds')
  ORDER BY scheduled_time ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE {s}.scheduled_events e SET status = 'locked', locked_at = now()
FROM due WHERE e.id = due.id
RETURNING e.*
```

2. For each claimed row: payload `{ id, scheduled_time, created_at, payload }` (Hasura's scheduled-webhook body), `deliverWebhook({ url, headers, payload, timeoutMs: timeout_seconds * 1000 })`.
3. Record every attempt in `scheduled_event_invocations`: `status` = HTTP status (null on network error), `request` = the payload JSON, `response` = `{ status, body }`.
4. Success → `status='delivered', tries=tries+1, locked_at=NULL`. Failure → `tries=tries+1`; if `tries+1 > num_retries` → `status='error'`, else `status='scheduled', next_retry_at = now() + retry_interval_seconds * interval '1 second'`, `locked_at=NULL`.
5. The poller must not overlap itself (skip tick if previous still running) and `stop()` must clearInterval and await the in-flight tick.

API (api.ts) — `POST /v1/metadata`, admin only (`request.session?.isAdmin`, else 403 `{ error: 'restricted access : admin only', path: '$', code: 'access-denied' }`), body `{ type, args }`:
- `create_scheduled_event` args `{ webhook, schedule_at, payload?, headers?, retry_conf?, comment? }` → INSERT (webhook→webhook_conf, schedule_at→scheduled_time, headers→header_conf) → 200 `{ message: 'success', event_id }`. 400 on missing webhook/schedule_at or unparseable timestamp: `{ error: <msg>, path: '$.args', code: 'parse-failed' }`.
- `delete_scheduled_event` args `{ type: 'one_off', event_id }` → DELETE → `{ message: 'success' }`; 400 `code: 'not-found'` if no row.
- `get_scheduled_event_invocations` args `{ event_id }` or `{ type: 'one_off' }` → `{ invocations: [...] }` rows ordered `created_at DESC` (id, event_id, status, request, response, created_at).
- any other `type` → 400 `{ error: 'unknown metadata command "<type>"', path: '$', code: 'parse-failed' }` (Hakkyra intentionally has no metadata-apply API; only scheduled-event commands are served).

- [x] **Step 1: Config plumbing** (schemas.ts / schemas-internal.ts / loader.ts) with `.describe()` on every field, defaults 10000/100, plus Zod tests for the defaults (same file as Task 5 Step 1). Run schema tests → PASS.

- [x] **Step 2: Write failing integration tests** `test/scheduled-events.test.ts`, following the module-level style of `test/events.test.ts` (real pool from `TEST_DB_URL`, `MockWebhookServer`, manager with `pollIntervalMs: 100`):
  - direct INSERT into `hakkyra.scheduled_events` (webhook_conf = mock URL, scheduled_time = now()) → webhook received with `{ id, scheduled_time, created_at, payload }`; row becomes `delivered`; one invocation row with status 200 and response body recorded.
  - past-due event with `scheduled_time` in the past is picked up (catchup).
  - failure path: mock returns 500, `retry_conf: { num_retries: 2, retry_interval_seconds: 0 }` → 3 invocations recorded, final status `error`.
  - future event (scheduled_time now()+1h) is NOT delivered.
  - API: build a bare Fastify instance, add a preHandler decorating `request.session = { isAdmin: true } as SessionVariables`, `registerScheduledEventRoutes`, then `inject` POST `/v1/metadata` `create_scheduled_event` → 200 + event_id lands in table; `get_scheduled_event_invocations` returns the recorded invocations; `delete_scheduled_event` removes; non-admin session → 403; unknown type → 400.

- [x] **Step 3: Run** `npm test -- scheduled-events` → FAIL (module missing).

- [x] **Step 4: Implement** schema.ts / delivery.ts / manager.ts / api.ts / index.ts as specified above. Manager deps: `{ pool, logger, schemaName, pollIntervalMs, batchSize }`; `init()` ensures DDL + starts the interval; `stop()` stops it.

- [x] **Step 5: Run** `npm test -- scheduled-events` → PASS.

- [x] **Step 6: Wire into the server.** `src/server/jobs.ts`: create + init the manager unconditionally (before the jobQueue block; it needs only `primaryPool`), add `scheduledEventManager` to `Phase2Result`; `src/server.ts`: register `registerScheduledEventRoutes(server, { pool: primaryPool, schemaName })` next to the other route registrations (before Phase 2 init is fine), and add `await phase2.scheduledEventManager?.stop();` to the shutdown sequence (before jobQueue). Run `npm test -- e2e` → PASS (server boots with the new module).

- [x] **Step 7: Commit** `feat: one-off scheduled events (Hasura hdb_scheduled_events equivalent)`

---

### Task 7: Docs + backlog bookkeeping

**Files:**
- Modify: `BACKLOG.md` (tick P13.1–P13.6 checkboxes; leave P13.7 unchecked; update the Test Summary table with new/changed suite counts from the final full run)
- Modify: `README.md` (if not already done in Task 5: pg_enums_as_scalars; add scheduled events section with the /v1/metadata RPC + direct-insert usage)

- [x] **Step 1:** Run `npm test` (full suite) and `npx tsc --noEmit`; record final counts.
- [x] **Step 2:** Update BACKLOG.md checkboxes + Test Summary; README additions.
- [x] **Step 3:** Commit `docs: mark acme migration findings P13.1-P13.6 done`

---

## Self-Review Notes

- **Spec coverage:** P13.1 → Task 5; P13.2 (both bullets) → Task 4; P13.3 → Task 1; P13.4 (both bullets: scheduling + invocation results) → Task 6; P13.5 → Task 3; P13.6 → Task 2; P13.7 is a acme-repo action (re-run their integration suite) — stays open, noted in Task 7.
- **Count stringification** relies on patching the CJS built-in Int/Float serializers — same precedent as the existing `applyStringCoercion` for String. Runtime-gated on `isStringifyNumericEnabled()` so hot reload with the flag toggled behaves.
- **Scalar-mode enum names are unchanged** (`PaymentState` stays `PaymentState`; kind changes enum→scalar), so SDL name parity with the acme Hasura deployment is preserved.
- **Ordering:** Tasks 1–3 are small independent fixes; Task 4 and 5 touch schema generation (5 is the churny one); Task 6 is standalone new code. Any order works; the listed order front-loads quick wins.
