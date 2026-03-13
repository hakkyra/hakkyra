/**
 * Event Triggers module.
 *
 * Implements the outbox pattern for reliable event delivery:
 * PG triggers → event_log table → pg-listen NOTIFY → pg-boss → webhook delivery.
 */

export { ensureEventSchema } from './schema.js';
export { installEventTriggers, removeEventTriggers } from './triggers.js';
export { enqueuePendingEvents, registerEventWorkers } from './delivery.js';
export { initEventTriggers } from './manager.js';
export type { EventManager } from './manager.js';
export { registerEventCleanup } from './cleanup.js';
