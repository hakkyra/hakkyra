/**
 * Config watcher for dev mode hot reload.
 *
 * Watches the metadata directory and server config file for changes,
 * debouncing rapid file saves into a single 'change' event.
 */

import { watch, type FSWatcher } from 'fs';
import { EventEmitter } from 'events';
import { resolve, extname } from 'path';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ConfigWatcherOptions {
  metadataDir: string;
  serverConfigPath?: string;
  /** Debounce interval in milliseconds (default: 500) */
  debounceMs?: number;
}

export interface ConfigWatcher extends EventEmitter {
  start(): void;
  stop(): void;
  on(event: 'change', listener: (files: string[]) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

// ─── Implementation ────────────────────────────────────────────────────────

const YAML_EXTENSIONS = new Set(['.yaml', '.yml', '.graphql']);

/**
 * Create a config file watcher.
 *
 * Watches the metadata directory recursively for YAML/GraphQL file changes,
 * and optionally the server config file. Emits 'change' events with the
 * list of changed file paths, debounced to avoid rapid-fire reloads.
 */
export function createConfigWatcher(options: ConfigWatcherOptions): ConfigWatcher {
  const {
    metadataDir,
    serverConfigPath,
    debounceMs = 500,
  } = options;

  const emitter = new EventEmitter() as ConfigWatcher;
  const watchers: FSWatcher[] = [];
  let changedFiles = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function handleChange(filename: string | null) {
    if (!filename) return;
    const ext = extname(filename).toLowerCase();
    if (!YAML_EXTENSIONS.has(ext)) return;

    changedFiles.add(filename);

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      const files = [...changedFiles];
      changedFiles = new Set();
      debounceTimer = null;
      emitter.emit('change', files);
    }, debounceMs);
  }

  emitter.start = () => {
    try {
      // Watch metadata directory recursively
      const metaWatcher = watch(
        resolve(metadataDir),
        { recursive: true },
        (_event, filename) => handleChange(filename),
      );
      metaWatcher.on('error', (err) => emitter.emit('error', err));
      watchers.push(metaWatcher);

      // Watch server config file if provided
      if (serverConfigPath) {
        const configWatcher = watch(
          resolve(serverConfigPath),
          (_event, filename) => handleChange(filename ?? serverConfigPath),
        );
        configWatcher.on('error', (err) => emitter.emit('error', err));
        watchers.push(configWatcher);
      }
    } catch (err) {
      emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  emitter.stop = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers.length = 0;
    changedFiles.clear();
  };

  return emitter;
}
