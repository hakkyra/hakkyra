/**
 * Shared type definitions for the server module.
 *
 * Centralises Mercurius-augmented Fastify types so that downstream modules
 * can access `app.graphql()`, `app.graphql.replaceSchema()`, etc. without
 * casting to `any`.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { MercuriusPlugin } from 'mercurius';
import type { Logger } from 'pino';
import type { SessionVariables } from '../types.js';

// ─── Mercurius-augmented Fastify instance ────────────────────────────────────

/**
 * A FastifyInstance that has been decorated by the Mercurius plugin.
 *
 * Use this type in modules that need to call `app.graphql()` or access
 * other Mercurius-decorated properties without importing mercurius directly
 * (which would be needed just to trigger the `declare module 'fastify'`
 * augmentation).
 */
export interface MercuriusFastifyInstance extends FastifyInstance {
  graphql: MercuriusPlugin;
}

// ─── Mercurius resolver context ──────────────────────────────────────────────

/**
 * Shape of the context object that Mercurius passes to lifecycle hooks
 * (preExecution, onResolution, etc.) after our context factory has run.
 *
 * The `auth` property is injected by our Mercurius context function in
 * server.ts; Mercurius adds its own properties (`app`, `reply`, `pubsub`,
 * etc.) but we only type what we actually access in hooks.
 */
export interface HookContext {
  auth?: {
    role?: string;
    isAdmin?: boolean;
  };
  /** Set by introspection preExecution hook for use in onResolution. */
  _introspectionDocument?: import('graphql').DocumentNode;
  /** Request headers — set by Mercurius context builder. */
  clientHeaders?: Record<string, string>;
}

// ─── Mercurius subscription context ──────────────────────────────────────────

/**
 * Shape of the context object passed to the subscription `context()` callback.
 *
 * Mercurius stores the `onConnect` return value on `_connectionInit` (or
 * sometimes directly on the context object), so we type both paths.
 */
export interface SubscriptionConnectionContext {
  _connectionInit?: {
    session?: SessionVariables;
    auth?: SessionVariables;
  };
  session?: SessionVariables;
  auth?: SessionVariables;
}

// ─── Mercurius execution error ───────────────────────────────────────────────

/**
 * Shape of the error that Mercurius throws when a GraphQL query fails
 * validation or execution. Mercurius attaches `statusCode` and `errors`
 * to the thrown Error object.
 */
export interface MercuriusExecutionError extends Error {
  statusCode?: number;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

// ─── Pino logger bridge ──────────────────────────────────────────────────────

/**
 * Safely upcast a FastifyBaseLogger to pino's Logger type.
 *
 * FastifyBaseLogger picks a subset of pino.BaseLogger and redefines `child()`
 * to return FastifyBaseLogger instead of Logger, making the two types not
 * directly assignable. At runtime they are the same pino instance, so this
 * cast is safe. Service managers (events, crons, actions, subscriptions)
 * currently accept `pino.Logger`; this helper avoids scattering
 * `as unknown as Logger` throughout the server bootstrap code.
 */
export function asPinoLogger(log: FastifyBaseLogger): Logger {
  return log as unknown as Logger;
}
