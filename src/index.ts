/**
 * Hakkyra — programmatic entry point.
 *
 * This module exports the public API for library use.
 * For CLI usage, see cli.ts.
 */

export { loadConfig } from './config/loader.js';
export { createServer } from './server.js';
export type { ServerOptions } from './server.js';
export { validateConfig } from './config/validator.js';
export { validateEnvironment } from './config/env.js';
export type { EnvValidationResult } from './config/env.js';
export type { HakkyraConfig, TableInfo } from './types.js';

// Re-export the start function for CLI use
export { startServer } from './commands/start.js';
