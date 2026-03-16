/**
 * Permissions module.
 *
 * Re-exports the permission lookup table builder.
 * Note: compileFilter is only used internally by lookup.ts (which imports it
 * directly from compiler.ts), so it is not re-exported here.
 */

export { buildPermissionLookup } from './lookup.js';
export type { PermissionLookup } from './lookup.js';
