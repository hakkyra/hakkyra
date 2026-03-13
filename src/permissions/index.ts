/**
 * Permissions module.
 *
 * Re-exports the permission filter compiler and the permission lookup table builder.
 */

export { compileFilter } from './compiler.js';

export { buildPermissionLookup } from './lookup.js';
export type { PermissionLookup } from './lookup.js';
