#!/usr/bin/env node
/**
 * Hakkyra CLI — subcommand dispatch.
 *
 * Usage:
 *   hakkyra start [options]    Start the server (production)
 *   hakkyra dev [options]      Start the server in dev mode (hot reload)
 *   hakkyra init [--force]     Scaffold a new Hakkyra project
 *   hakkyra --version, -v      Show version
 *   hakkyra --help, -h         Show help
 *
 * The old flag-only interface (hakkyra --port 3000 --dev) is still supported
 * for backwards compatibility and is equivalent to `hakkyra start --port 3000 --dev`.
 */

import { createRequire } from 'node:module';
import { startServer } from './commands/start.js';
import type { StartOptions } from './commands/start.js';
import { initProject } from './commands/init.js';
import { CONFIG_DEFAULTS } from './config/schemas-internal.js';

// ─── Version ────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

// ─── Help text ──────────────────────────────────────────────────────────────

const HELP = `
Hakkyra — Auto-generate GraphQL + REST APIs from PostgreSQL

Usage:
  hakkyra <command> [options]

Commands:
  start              Start the server (production mode)
  dev                Start the server in dev mode (hot reload)
  init               Scaffold a new Hakkyra project

Options (start / dev):
  --port <number>    Server port (default: 3000)
  --host <string>    Server host (default: 0.0.0.0)
  --config <path>    Path to hakkyra.yaml config file (default: ./hakkyra.yaml)
  --metadata <path>  Path to metadata directory (default: ./metadata)
  --dev              Enable dev mode (same as \`hakkyra dev\`)

Options (init):
  --force            Overwrite existing files

Global:
  --help, -h         Show this help message
  --version, -v      Show version

Examples:
  hakkyra start --port 8080
  hakkyra dev
  hakkyra init
  hakkyra init --force
`;

// ─── Arg parsing for start/dev ──────────────────────────────────────────────

function parseStartArgs(args: string[], forceDevMode: boolean): StartOptions {
  const explicit = new Set<string>();
  const options: StartOptions = {
    port: 3000,
    host: '0.0.0.0',
    configPath: CONFIG_DEFAULTS.configPath,
    metadataPath: CONFIG_DEFAULTS.metadataPath,
    devMode: forceDevMode,
    explicit,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--port':
        if (next) {
          const port = parseInt(next, 10);
          if (!Number.isNaN(port) && port > 0 && port <= 65535) {
            options.port = port;
            explicit.add('port');
          } else {
            console.error(`Invalid port: ${next}`);
            process.exit(1);
          }
          i++;
        }
        break;

      case '--host':
        if (next) {
          options.host = next;
          explicit.add('host');
          i++;
        }
        break;

      case '--config':
        if (next) {
          options.configPath = next;
          i++;
        }
        break;

      case '--metadata':
        if (next) {
          options.metadataPath = next;
          i++;
        }
        break;

      case '--dev':
        options.devMode = true;
        break;

      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;

      default:
        console.error(`Unknown option: ${arg}`);
        console.error(`Run 'hakkyra --help' for usage.`);
        process.exit(1);
    }
  }

  return options;
}

// ─── Arg parsing for init ───────────────────────────────────────────────────

function parseInitArgs(args: string[]): { force: boolean } {
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--force':
        force = true;
        break;

      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;

      default:
        console.error(`Unknown option for init: ${arg}`);
        console.error(`Run 'hakkyra --help' for usage.`);
        process.exit(1);
    }
  }

  return { force };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isFlag(arg: string): boolean {
  return arg.startsWith('-');
}

// ─── Main dispatch ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No args → show help
  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const first = args[0];

  // Global flags (before any subcommand)
  if (first === '--help' || first === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (first === '--version' || first === '-v') {
    console.log(`hakkyra v${pkg.version}`);
    process.exit(0);
  }

  // Subcommand dispatch
  if (first === 'start') {
    const options = parseStartArgs(args.slice(1), false);
    await startServer(options);
    return;
  }

  if (first === 'dev') {
    const options = parseStartArgs(args.slice(1), true);
    await startServer(options);
    return;
  }

  if (first === 'init') {
    const initOpts = parseInitArgs(args.slice(1));
    await initProject(initOpts);
    return;
  }

  // Backwards compatibility: if the first arg is a flag (e.g. --port, --dev),
  // treat the entire invocation as `hakkyra start <args>`.
  if (isFlag(first)) {
    const options = parseStartArgs(args, false);
    await startServer(options);
    return;
  }

  // Unknown subcommand
  console.error(`Unknown command: ${first}`);
  console.error(`Run 'hakkyra --help' for usage.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
