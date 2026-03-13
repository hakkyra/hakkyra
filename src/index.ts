/**
 * Hakkyra CLI entry point.
 *
 * Parses command-line arguments, loads configuration and metadata,
 * creates the server, and starts listening.
 *
 * Usage:
 *   hakkyra [options]
 *
 * Options:
 *   --port <number>      Server port (default: 3000)
 *   --host <string>      Server host (default: 0.0.0.0)
 *   --config <path>      Path to hakkyra.yaml config file (default: ./hakkyra.yaml)
 *   --metadata <path>    Path to Hasura metadata directory (default: ./metadata)
 */

import { loadConfig } from './config/loader.js';
import { createServer } from './server.js';

// ─── CLI argument parsing ────────────────────────────────────────────────────

interface CLIArgs {
  port: number;
  host: string;
  configPath: string;
  metadataPath: string;
  devMode: boolean;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const parsed: CLIArgs = {
    port: 3000,
    host: '0.0.0.0',
    configPath: './hakkyra.yaml',
    metadataPath: './metadata',
    devMode: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--port':
        if (next) {
          const port = parseInt(next, 10);
          if (!Number.isNaN(port) && port > 0 && port <= 65535) {
            parsed.port = port;
          } else {
            console.error(`Invalid port: ${next}`);
            process.exit(1);
          }
          i++;
        }
        break;

      case '--host':
        if (next) {
          parsed.host = next;
          i++;
        }
        break;

      case '--config':
        if (next) {
          parsed.configPath = next;
          i++;
        }
        break;

      case '--metadata':
        if (next) {
          parsed.metadataPath = next;
          i++;
        }
        break;

      case '--dev':
        parsed.devMode = true;
        break;

      case '--help':
      case '-h':
        console.log(`
Hakkyra — Auto-generate GraphQL + REST APIs from PostgreSQL

Usage:
  hakkyra [options]

Options:
  --port <number>      Server port (default: 3000)
  --host <string>      Server host (default: 0.0.0.0)
  --config <path>      Path to hakkyra.yaml config file (default: ./hakkyra.yaml)
  --metadata <path>    Path to Hasura metadata directory (default: ./metadata)
  --dev                Enable dev mode with config hot reload
  --help, -h           Show this help message
`);
        process.exit(0);
        break;

      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return parsed;
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs();

  console.log('');
  console.log('  Hakkyra starting...');
  console.log('');

  // Load configuration
  let config;
  try {
    config = await loadConfig(cliArgs.metadataPath, cliArgs.configPath);
  } catch (err) {
    console.error('Failed to load configuration:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Override server config with CLI args
  config.server.port = cliArgs.port;
  config.server.host = cliArgs.host;

  // Create the server
  let server;
  try {
    server = await createServer(config, {
      devMode: cliArgs.devMode,
      metadataPath: cliArgs.metadataPath,
      configPath: cliArgs.configPath,
    });
  } catch (err) {
    console.error('Failed to create server:', err instanceof Error ? err.message : err);
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

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
