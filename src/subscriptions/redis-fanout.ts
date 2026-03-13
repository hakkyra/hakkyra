/**
 * Redis pub/sub fanout bridge for multi-instance subscriptions.
 *
 * When Hakkyra runs behind a load balancer with multiple instances,
 * only one instance receives each PG LISTEN/NOTIFY. This bridge
 * republishes notifications to Redis so all instances re-query
 * their local subscriptions.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { ChangeNotification } from './listener.js';
import type { RedisConfig } from '../types.js';

const CHANNEL = 'hakkyra:sub:changes';

export interface RedisFanoutBridge {
  /** Start the Redis subscriber. Call after PG listener is connected. */
  start(): Promise<void>;
  /** Publish a PG notification to Redis for all instances. */
  publish(notification: ChangeNotification): Promise<void>;
  /** Register a handler for notifications received from other instances. */
  onRemoteChange(callback: (notification: ChangeNotification) => void): void;
  /** Gracefully close Redis connections. */
  stop(): Promise<void>;
}

interface FanoutMessage {
  instanceId: string;
  notification: ChangeNotification;
}

/**
 * Create a Redis fanout bridge.
 *
 * Requires `ioredis` to be installed (optional dependency).
 * Uses two Redis connections: one for SUBSCRIBE (blocked), one for PUBLISH.
 */
export async function createRedisFanoutBridge(
  redisConfig: RedisConfig,
  logger: Logger,
): Promise<RedisFanoutBridge> {
  // Dynamic import — ioredis is an optional dependency
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Redis: any;
  try {
    const mod = await import('ioredis');
    Redis = mod.default;
  } catch {
    throw new Error(
      'ioredis is not installed. Install it with: npm install ioredis\n' +
        'ioredis is required for multi-instance subscription fanout via Redis.',
    );
  }

  const instanceId = randomUUID();
  const callbacks: Array<(notification: ChangeNotification) => void> = [];

  // Build connection options
  const connectionOpts = redisConfig.url
    ? redisConfig.url
    : {
        host: redisConfig.host ?? 'localhost',
        port: redisConfig.port ?? 6379,
        ...(redisConfig.password ? { password: redisConfig.password } : {}),
      };

  // Two connections: one for sub (blocked in subscribe mode), one for pub
  const sub = new Redis(connectionOpts);
  const pub = new Redis(connectionOpts);

  return {
    async start(): Promise<void> {
      await sub.subscribe(CHANNEL);
      sub.on('message', (_channel: string, message: string) => {
        try {
          const parsed: FanoutMessage = JSON.parse(message);
          // Skip our own messages — we already handled the PG notification locally
          if (parsed.instanceId === instanceId) return;

          for (const cb of callbacks) {
            cb(parsed.notification);
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to parse Redis fanout message');
        }
      });

      logger.info({ instanceId, channel: CHANNEL }, 'Redis fanout bridge started');
    },

    async publish(notification: ChangeNotification): Promise<void> {
      const message: FanoutMessage = { instanceId, notification };
      await pub.publish(CHANNEL, JSON.stringify(message));
    },

    onRemoteChange(callback: (notification: ChangeNotification) => void): void {
      callbacks.push(callback);
    },

    async stop(): Promise<void> {
      await sub.unsubscribe(CHANNEL);
      sub.disconnect();
      pub.disconnect();
      logger.info('Redis fanout bridge stopped');
    },
  };
}
