/**
 * Event Triggers module.
 *
 * Implements the outbox pattern for reliable event delivery:
 * PG triggers → event_log table → pg-listen NOTIFY → pg-boss → webhook delivery.
 */

export { ensureEventSchema } from './schema.js';
export { installEventTriggers, removeEventTriggers, generateEventTriggerSQL } from './triggers.js';
export type { GeneratedEventTrigger } from './triggers.js';
export { enqueuePendingEvents, registerEventWorkers, buildEventPayload } from './delivery.js';
export type { EventLogRow } from './delivery.js';
export { createEventManager } from './manager.js';
export type { EventManagerDeps } from './manager.js';
export { registerEventCleanup } from './cleanup.js';
export { registerInvokeRoute } from './invoke.js';
export type { InvokeRouteDeps } from './invoke.js';
