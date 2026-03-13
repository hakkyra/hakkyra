/**
 * Change notification listener.
 *
 * Wraps pg-listen to receive NOTIFY messages from PostgreSQL
 * when tracked table data changes.
 */

import createSubscriber from 'pg-listen';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ChangeNotification {
  table: string;
  schema: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
}

export interface ChangeListener {
  start(): Promise<void>;
  stop(): Promise<void>;
  onTableChange(callback: (notification: ChangeNotification) => void): void;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a change notification listener connected to PostgreSQL.
 *
 * Listens on the `hakkyra_changes` channel for NOTIFY messages
 * fired by the subscription triggers.
 */
export function createChangeListener(connectionString: string): ChangeListener {
  const subscriber = createSubscriber({ connectionString });
  const callbacks: Array<(notification: ChangeNotification) => void> = [];

  subscriber.notifications.on('hakkyra_changes', (payload) => {
    const notification = payload as ChangeNotification;
    for (const cb of callbacks) {
      cb(notification);
    }
  });

  return {
    async start(): Promise<void> {
      await subscriber.connect();
      await subscriber.listenTo('hakkyra_changes');
    },

    async stop(): Promise<void> {
      await subscriber.close();
    },

    onTableChange(callback: (notification: ChangeNotification) => void): void {
      callbacks.push(callback);
    },
  };
}
