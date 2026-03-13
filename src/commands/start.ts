/**
 * Start command — loads config, creates server, and starts listening.
 *
 * This is the core server startup logic, extracted from the old index.ts
 * so it can be called both from the CLI and programmatically.
 */

import { loadConfig } from '../config/loader.js';
import { validateEnvironment } from '../config/env.js';
import { createServer } from '../server.js';

export interface StartOptions {
  port: number;
  host: string;
  configPath: string;
  metadataPath: string;
  devMode: boolean;
}

export async function startServer(options: StartOptions): Promise<void> {
  console.log('');
  console.log('  Hakkyra starting...');
  console.log('');

  // Load configuration
  let config;
  try {
    config = await loadConfig(options.metadataPath, options.configPath);
  } catch (err) {
    console.error('Failed to load configuration:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Override server config with CLI args
  config.server.port = options.port;
  config.server.host = options.host;

  // Validate environment variables before starting
  const envResult = validateEnvironment(config);
  if (envResult.warnings.length > 0) {
    for (const warning of envResult.warnings) {
      console.warn(`  [warn] Missing env var: ${warning}`);
    }
  }
  if (!envResult.valid) {
    console.error('');
    console.error('  Missing required environment variables:');
    for (const entry of envResult.missing) {
      console.error(`    - ${entry}`);
    }
    console.error('');
    process.exit(1);
  }

  // Create the server
  let server;
  try {
    server = await createServer(config, {
      devMode: options.devMode,
      metadataPath: options.metadataPath,
      configPath: options.configPath,
    });
  } catch (err) {
    const msg = err instanceof Error ? (err.message || err.stack || String(err)) : String(err);
    console.error('Failed to create server:', msg);
    process.exit(1);
  }

  // Start listening
  try {
    const address = await server.listen({
      port: config.server.port,
      host: config.server.host,
    });

    const trackedCount = server.trackedTables.length;
    const restBase = config.rest.basePath;

    console.log('');
    console.log(`  Hakkyra is running`);
    console.log('');
    console.log(`    Address:          ${address}`);
    console.log(`    GraphQL:          ${address}/graphql`);
    console.log(`    REST API:         ${address}${restBase}`);
    console.log(`    Tracked tables:   ${trackedCount}`);
    console.log(`    Health check:     ${address}/healthz`);
    console.log(`    Readiness check:  ${address}/readyz`);
    console.log('');
  } catch (err) {
    console.error('Failed to start server:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
