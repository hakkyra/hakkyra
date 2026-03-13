/**
 * GraphQL Subscriptions module.
 *
 * Provides real-time data updates via WebSocket using the
 * LISTEN/NOTIFY + re-query + hash-diff approach.
 */

export { installSubscriptionTriggers, removeSubscriptionTriggers } from './triggers.js';
export { createChangeListener } from './listener.js';
export type { ChangeListener, ChangeNotification } from './listener.js';
export { createSubscriptionManager } from './manager.js';
export type { SubscriptionManager, SubscriptionEntry } from './manager.js';
