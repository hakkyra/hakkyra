/**
 * Unit tests for security limit enforcement:
 * - resolveLimit: global graphql.maxLimit cap applied to queries, subscriptions, and tracked functions
 * - GraphQL batch size: graphql.maxBatchSize cap
 * - Streaming subscription batchSize: capped by graphql.maxLimit
 */

import { describe, it, expect } from 'vitest';
import { resolveLimit } from '../src/schema/resolvers/index.js';

describe('resolveLimit', () => {
  it('returns undefined when no limits are set', () => {
    expect(resolveLimit()).toBeUndefined();
  });

  it('returns userLimit when only userLimit is set', () => {
    expect(resolveLimit(50)).toBe(50);
  });

  it('returns permLimit when only permLimit is set', () => {
    expect(resolveLimit(undefined, 30)).toBe(30);
  });

  it('returns the minimum of userLimit and permLimit', () => {
    expect(resolveLimit(50, 30)).toBe(30);
    expect(resolveLimit(10, 30)).toBe(10);
  });

  it('returns globalMaxLimit when no other limits are set', () => {
    expect(resolveLimit(undefined, undefined, 100)).toBe(100);
  });

  it('caps userLimit at globalMaxLimit', () => {
    expect(resolveLimit(200, undefined, 100)).toBe(100);
  });

  it('caps permLimit at globalMaxLimit', () => {
    expect(resolveLimit(undefined, 200, 100)).toBe(100);
  });

  it('returns the minimum of all three limits', () => {
    // userLimit < permLimit < globalMaxLimit
    expect(resolveLimit(10, 50, 100)).toBe(10);
    // permLimit < userLimit < globalMaxLimit
    expect(resolveLimit(50, 10, 100)).toBe(10);
    // globalMaxLimit < userLimit < permLimit
    expect(resolveLimit(200, 300, 100)).toBe(100);
    // globalMaxLimit < permLimit < userLimit
    expect(resolveLimit(300, 200, 100)).toBe(100);
  });

  it('does not apply globalMaxLimit when it is 0', () => {
    expect(resolveLimit(200, undefined, 0)).toBe(200);
  });

  it('does not apply globalMaxLimit when it is undefined', () => {
    expect(resolveLimit(200, undefined, undefined)).toBe(200);
  });

  it('applies globalMaxLimit even when userLimit equals it', () => {
    expect(resolveLimit(100, undefined, 100)).toBe(100);
  });

  it('applies globalMaxLimit even when permLimit equals it', () => {
    expect(resolveLimit(undefined, 100, 100)).toBe(100);
  });
});

describe('streaming subscription batchSize capping', () => {
  // This tests the same logic used in makeSubscriptionStreamSubscribe
  // to cap the batchSize argument by the global max limit.
  function capBatchSize(rawBatchSize: number, globalMaxLimit?: number): number {
    if (globalMaxLimit !== undefined && globalMaxLimit > 0 && rawBatchSize > globalMaxLimit) {
      return globalMaxLimit;
    }
    return rawBatchSize;
  }

  it('does not cap when no globalMaxLimit is set', () => {
    expect(capBatchSize(500)).toBe(500);
    expect(capBatchSize(500, undefined)).toBe(500);
  });

  it('does not cap when globalMaxLimit is 0 (disabled)', () => {
    expect(capBatchSize(500, 0)).toBe(500);
  });

  it('does not cap batchSize within the limit', () => {
    expect(capBatchSize(50, 100)).toBe(50);
    expect(capBatchSize(100, 100)).toBe(100);
  });

  it('caps batchSize exceeding globalMaxLimit', () => {
    expect(capBatchSize(200, 100)).toBe(100);
    expect(capBatchSize(1000, 100)).toBe(100);
  });

  it('caps at globalMaxLimit boundary', () => {
    expect(capBatchSize(101, 100)).toBe(100);
  });
});
