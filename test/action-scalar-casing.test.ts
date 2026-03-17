/**
 * P12.15 — Scalar casing in action args.
 *
 * Hasura preserves the exact scalar name from actions.graphql SDL:
 * - `numeric` (lowercase) stays `numeric` (not `Numeric`)
 * - `jsonb` (lowercase) stays `jsonb` (not `Jsonb`)
 * - `Numeric` (PascalCase) stays `Numeric`
 * - `Jsonb` (PascalCase) stays `Jsonb`
 *
 * This unit test validates that buildActionFields preserves scalar casing.
 */

import { describe, it, expect } from 'vitest';
import { buildActionFields } from '../src/actions/schema.js';
import type { GraphQLObjectType, GraphQLInputObjectType, GraphQLNamedType } from 'graphql';
import type { ActionConfig } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getFieldTypeName(
  type: import('graphql').GraphQLOutputType | import('graphql').GraphQLInputType,
): string {
  return type.toString();
}

function findType<T extends GraphQLNamedType>(types: GraphQLNamedType[], name: string): T | undefined {
  return types.find((t) => t.name === name) as T | undefined;
}

// ─── Test SDL with mixed-casing scalars ──────────────────────────────────────

const SDL_MIXED_CASING = `
type Mutation {
  startDeposit(input: StartDepositInput!): StartDepositResult
}

input StartDepositInput {
  amount: numeric!
  data: jsonb
  userId: Uuid!
  label: String
}

type StartDepositResult {
  id: Uuid!
  amount: numeric!
  fee: Numeric
  data: jsonb
  metadata: Jsonb
  success: Boolean!
}
`;

const ACTIONS: ActionConfig[] = [
  {
    name: 'startDeposit',
    definition: {
      kind: 'synchronous',
      type: 'mutation',
      handler: 'http://localhost:3000/start-deposit',
      forwardClientHeaders: false,
      headers: [],
    },
    permissions: [{ role: 'user' }],
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('P12.15 — Scalar casing in action args', () => {
  const result = buildActionFields(ACTIONS, SDL_MIXED_CASING);

  it('preserves numeric (lowercase) in input type fields', () => {
    const inputType = findType<GraphQLInputObjectType>(result.types, 'StartDepositInput');
    expect(inputType).toBeDefined();

    const fields = inputType!.getFields();
    // amount: numeric! — should use lowercase `numeric` scalar
    expect(getFieldTypeName(fields['amount'].type)).toBe('numeric!');
  });

  it('preserves jsonb (lowercase) in input type fields', () => {
    const inputType = findType<GraphQLInputObjectType>(result.types, 'StartDepositInput');
    expect(inputType).toBeDefined();

    const fields = inputType!.getFields();
    // data: jsonb — should use lowercase `jsonb` scalar
    expect(getFieldTypeName(fields['data'].type)).toBe('jsonb');
  });

  it('preserves Uuid (PascalCase) in input type fields', () => {
    const inputType = findType<GraphQLInputObjectType>(result.types, 'StartDepositInput');
    expect(inputType).toBeDefined();

    const fields = inputType!.getFields();
    // userId: Uuid! — should use PascalCase `Uuid` scalar
    expect(getFieldTypeName(fields['userId'].type)).toBe('Uuid!');
  });

  it('preserves numeric (lowercase) in output type fields', () => {
    const outputType = findType<GraphQLObjectType>(result.types, 'StartDepositResult');
    expect(outputType).toBeDefined();

    const fields = outputType!.getFields();
    // amount: numeric! — should use lowercase `numeric` scalar
    expect(getFieldTypeName(fields['amount'].type)).toBe('numeric!');
  });

  it('preserves Numeric (PascalCase) in output type fields', () => {
    const outputType = findType<GraphQLObjectType>(result.types, 'StartDepositResult');
    expect(outputType).toBeDefined();

    const fields = outputType!.getFields();
    // fee: Numeric — should use PascalCase `Numeric` scalar
    expect(getFieldTypeName(fields['fee'].type)).toBe('Numeric');
  });

  it('preserves jsonb (lowercase) in output type fields', () => {
    const outputType = findType<GraphQLObjectType>(result.types, 'StartDepositResult');
    expect(outputType).toBeDefined();

    const fields = outputType!.getFields();
    // data: jsonb — should use lowercase `jsonb` scalar
    expect(getFieldTypeName(fields['data'].type)).toBe('jsonb');
  });

  it('preserves Jsonb (PascalCase) in output type fields', () => {
    const outputType = findType<GraphQLObjectType>(result.types, 'StartDepositResult');
    expect(outputType).toBeDefined();

    const fields = outputType!.getFields();
    // metadata: Jsonb — should use PascalCase `Jsonb` scalar
    expect(getFieldTypeName(fields['metadata'].type)).toBe('Jsonb');
  });

  it('mutation field args use the correct input type', () => {
    const mutation = result.mutationFields['startDeposit'];
    expect(mutation).toBeDefined();

    // Return type should reference the output type with lowercase numeric
    const returnType = mutation.type as GraphQLObjectType;
    const returnFields = returnType.getFields();
    expect(getFieldTypeName(returnFields['amount'].type)).toBe('numeric!');
    expect(getFieldTypeName(returnFields['fee'].type)).toBe('Numeric');
  });
});

// ─── Inline args casing test ──────────────────────────────────────────────────

const SDL_INLINE_ARGS = `
extend type Mutation {
  updateLimit(
    type: String!
    amount: numeric
    threshold: Numeric!
    payload: jsonb
    config: Jsonb!
  ): UpdateLimitResult
}

type UpdateLimitResult {
  ok: Boolean!
}
`;

const INLINE_ACTIONS: ActionConfig[] = [
  {
    name: 'updateLimit',
    definition: {
      kind: 'synchronous',
      type: 'mutation',
      handler: 'http://localhost:3000/update-limit',
      forwardClientHeaders: false,
      headers: [],
    },
    permissions: [{ role: 'user' }],
  },
];

describe('P12.15 — Scalar casing in inline action args', () => {
  const result = buildActionFields(INLINE_ACTIONS, SDL_INLINE_ARGS);

  it('preserves numeric (lowercase) in inline args', () => {
    const mutation = result.mutationFields['updateLimit'];
    expect(mutation).toBeDefined();

    const args = mutation.args!;
    expect(getFieldTypeName(args['amount'].type)).toBe('numeric');
  });

  it('preserves Numeric (PascalCase) in inline args', () => {
    const mutation = result.mutationFields['updateLimit'];
    expect(mutation).toBeDefined();

    const args = mutation.args!;
    expect(getFieldTypeName(args['threshold'].type)).toBe('Numeric!');
  });

  it('preserves jsonb (lowercase) in inline args', () => {
    const mutation = result.mutationFields['updateLimit'];
    expect(mutation).toBeDefined();

    const args = mutation.args!;
    expect(getFieldTypeName(args['payload'].type)).toBe('jsonb');
  });

  it('preserves Jsonb (PascalCase) in inline args', () => {
    const mutation = result.mutationFields['updateLimit'];
    expect(mutation).toBeDefined();

    const args = mutation.args!;
    expect(getFieldTypeName(args['config'].type)).toBe('Jsonb!');
  });
});
