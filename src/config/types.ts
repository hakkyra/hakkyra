/**
 * Raw YAML types representing Hasura metadata format before transformation.
 *
 * All types are inferred from the Zod schemas in ./schemas.ts — the schemas
 * are the single source of truth for both runtime validation and static types.
 */

import { z } from 'zod';
import type {
  RawVersionYamlSchema,
  RawDatabaseEntrySchema,
  RawDatabasesYamlSchema,
  RawTableReferenceSchema,
  RawTableYamlSchema,
  RawComputedFieldSchema,
  RawRelationshipSchema,
  RawSelectPermissionSchema,
  RawInsertPermissionSchema,
  RawUpdatePermissionSchema,
  RawDeletePermissionSchema,
  RawSelectPermissionEntrySchema,
  RawInsertPermissionEntrySchema,
  RawUpdatePermissionEntrySchema,
  RawDeletePermissionEntrySchema,
  RawHeaderSchema,
  RawEventTriggerSchema,
  RawActionSchema,
  RawActionsYamlSchema,
  RawCronTriggerSchema,
  RawApiConfigSchema,
  RawCustomQuerySchema,
  RawRESTOverrideSchema,
  RawServerConfigSchema,
} from './schemas.js';

// ─── Hasura metadata version ────────────────────────────────────────────────

export type RawVersionYaml = z.infer<typeof RawVersionYamlSchema>;

// ─── Database configuration ─────────────────────────────────────────────────

export type RawDatabaseEntry = z.infer<typeof RawDatabaseEntrySchema>;
export type RawDatabasesYaml = z.infer<typeof RawDatabasesYamlSchema>;

// ─── Table configuration ────────────────────────────────────────────────────

export type RawTableReference = z.infer<typeof RawTableReferenceSchema>;
export type RawTableYaml = z.infer<typeof RawTableYamlSchema>;
export type RawComputedField = z.infer<typeof RawComputedFieldSchema>;
export type RawRelationship = z.infer<typeof RawRelationshipSchema>;

// ─── Permissions ────────────────────────────────────────────────────────────

export type RawSelectPermission = z.infer<typeof RawSelectPermissionSchema>;
export type RawInsertPermission = z.infer<typeof RawInsertPermissionSchema>;
export type RawUpdatePermission = z.infer<typeof RawUpdatePermissionSchema>;
export type RawDeletePermission = z.infer<typeof RawDeletePermissionSchema>;

export type RawSelectPermissionEntry = z.infer<typeof RawSelectPermissionEntrySchema>;
export type RawInsertPermissionEntry = z.infer<typeof RawInsertPermissionEntrySchema>;
export type RawUpdatePermissionEntry = z.infer<typeof RawUpdatePermissionEntrySchema>;
export type RawDeletePermissionEntry = z.infer<typeof RawDeletePermissionEntrySchema>;

// ─── Event triggers ─────────────────────────────────────────────────────────

export type RawEventTrigger = z.infer<typeof RawEventTriggerSchema>;
export type RawHeader = z.infer<typeof RawHeaderSchema>;

// ─── Actions ────────────────────────────────────────────────────────────────

export type RawActionsYaml = z.infer<typeof RawActionsYamlSchema>;
export type RawAction = z.infer<typeof RawActionSchema>;

// ─── Cron triggers ──────────────────────────────────────────────────────────

export type RawCronTrigger = z.infer<typeof RawCronTriggerSchema>;

// ─── Hakkyra extension: api_config.yaml ─────────────────────────────────────

export type RawApiConfig = z.infer<typeof RawApiConfigSchema>;
export type RawCustomQuery = z.infer<typeof RawCustomQuerySchema>;
export type RawRESTOverride = z.infer<typeof RawRESTOverrideSchema>;

// ─── Server config (standalone) ─────────────────────────────────────────────

export type RawServerConfig = z.infer<typeof RawServerConfigSchema>;

// ─── Include tag marker ─────────────────────────────────────────────────────

export class IncludeRef {
  constructor(public readonly path: string) {}
}
