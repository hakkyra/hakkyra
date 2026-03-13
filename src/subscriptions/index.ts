/**
 * GraphQL Subscriptions module.
 *
 * Provides real-time data updates via WebSocket using the
 * LISTEN/NOTIFY + re-query + hash-diff approach.
 */

export {
  installSubscriptionTriggers,
  removeSubscriptionTriggers,
  SUBSCRIPTION_FUNCTION_BODY,
  SUBSCRIPTION_FUNCTION_SQL,
  generateSubscriptionTriggerSQL,
} from './triggers.js';
export { createChangeListener } from './listener.js';
export type { ChangeListener, ChangeNotification } from './listener.js';
export { createSubscriptionManager } from './manager.js';
export type { SubscriptionManager, SubscriptionEntry, SubscriptionManagerOptions } from './manager.js';
export { createRedisFanoutBridge } from './redis-fanout.js';
export type { RedisFanoutBridge } from './redis-fanout.js';
