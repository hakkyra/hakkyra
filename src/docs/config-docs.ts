/**
 * Config documentation generator — walks Zod schemas and emits structured docs.
 *
 * Introspects Zod's internal `_def` and uses `instanceof` checks to extract
 * field names, types, defaults, required/optional status, and `.describe()`
 * annotations.
 *
 * Compatible with Zod v4 where `_def.typeName` no longer exists.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldDoc {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
  enumValues?: string[];
  children?: FieldDoc[];
}

export interface SchemaDoc {
  name: string;
  description?: string;
  fields: FieldDoc[];
}

export interface ConfigDocsResult {
  schemas: SchemaDoc[];
}

// ---------------------------------------------------------------------------
// Zod introspection helpers (Zod v4 compatible)
// ---------------------------------------------------------------------------

/** Unwrap wrappers (optional, default, nullable) and collect metadata. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; isOptional: boolean; defaultValue?: unknown } {
  let isOptional = false;
  let defaultValue: unknown = undefined;
  let current = schema;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (current instanceof z.ZodOptional) {
      isOptional = true;
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      isOptional = true; // defaults make a field effectively optional in YAML
      defaultValue = current._def.defaultValue;
      current = current._def.innerType;
    } else if (current instanceof z.ZodNullable) {
      isOptional = true;
      current = current.unwrap();
    } else {
      break;
    }
  }

  return { inner: current, isOptional, defaultValue };
}

/** Get a human-readable type string for a Zod schema. */
function zodTypeName(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodLiteral) {
    const vals = schema._def.values as unknown[];
    return vals.map((v: unknown) => JSON.stringify(v)).join(' | ');
  }
  if (schema instanceof z.ZodEnum) {
    const opts = (schema as z.ZodEnum<[string, ...string[]]>).options;
    return opts.map((v: string) => `"${v}"`).join(' | ');
  }
  if (schema instanceof z.ZodArray) {
    return `${zodTypeName(schema._def.element)}[]`;
  }
  if (schema instanceof z.ZodObject) return 'object';
  if (schema instanceof z.ZodRecord) {
    return `Record<${zodTypeName(schema._def.keyType)}, ${zodTypeName(schema._def.valueType)}>`;
  }
  if (schema instanceof z.ZodMap) {
    return `Map<${zodTypeName(schema._def.keyType)}, ${zodTypeName(schema._def.valueType)}>`;
  }
  if (schema instanceof z.ZodUnion) {
    return (schema._def.options as z.ZodTypeAny[])
      .map((opt: z.ZodTypeAny) => zodTypeName(opt))
      .join(' | ');
  }
  if (schema instanceof z.ZodUnknown) return 'unknown';
  if (schema instanceof z.ZodAny) return 'any';
  if (schema instanceof z.ZodNull) return 'null';
  if (schema instanceof z.ZodUndefined) return 'undefined';
  if (schema instanceof z.ZodVoid) return 'void';
  if (schema instanceof z.ZodNever) return 'never';

  return 'unknown';
}

/** Extract enum values from a schema (if applicable). */
function getEnumValues(schema: z.ZodTypeAny): string[] | undefined {
  if (schema instanceof z.ZodEnum) {
    return (schema as z.ZodEnum<[string, ...string[]]>).options as string[];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schema walker
// ---------------------------------------------------------------------------

function walkObject(schema: z.ZodObject<z.ZodRawShape>): FieldDoc[] {
  const shape = schema.shape;
  const fields: FieldDoc[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const raw = value as z.ZodTypeAny;
    fields.push(walkField(key, raw));
  }

  return fields;
}

function walkField(name: string, schema: z.ZodTypeAny): FieldDoc {
  const description = schema.description;
  const { inner, isOptional, defaultValue } = unwrap(schema);

  const field: FieldDoc = {
    name,
    type: zodTypeName(inner),
    required: !isOptional,
    description: description ?? inner.description,
  };

  if (defaultValue !== undefined) {
    field.default = defaultValue;
  }

  const enums = getEnumValues(inner);
  if (enums) {
    field.enumValues = enums;
  }

  // Recurse into objects
  if (inner instanceof z.ZodObject) {
    field.children = walkObject(inner as z.ZodObject<z.ZodRawShape>);
  }

  // Recurse into arrays of objects
  if (inner instanceof z.ZodArray) {
    const elementType = inner._def.element;
    const { inner: elementInner } = unwrap(elementType);
    if (elementInner instanceof z.ZodObject) {
      field.children = walkObject(elementInner as z.ZodObject<z.ZodRawShape>);
    }
  }

  // Recurse into record values if they are objects
  if (inner instanceof z.ZodRecord) {
    const valueType = inner._def.valueType;
    const { inner: valueInner } = unwrap(valueType);
    if (valueInner instanceof z.ZodObject) {
      field.children = walkObject(valueInner as z.ZodObject<z.ZodRawShape>);
    }
  }

  return field;
}

/** Walk a named Zod schema and produce a SchemaDoc. */
export function documentSchema(name: string, schema: z.ZodTypeAny): SchemaDoc {
  const { inner } = unwrap(schema);

  const doc: SchemaDoc = {
    name,
    description: schema.description ?? inner.description,
    fields: [],
  };

  if (inner instanceof z.ZodObject) {
    doc.fields = walkObject(inner as z.ZodObject<z.ZodRawShape>);
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Full config docs generator
// ---------------------------------------------------------------------------

import {
  RawServerConfigSchema,
  RawDatabasesYamlSchema,
  RawDatabaseEntrySchema,
  RawTableYamlSchema,
  RawActionsYamlSchema,
  RawActionSchema,
  RawCronTriggerSchema,
  RawTrackedFunctionSchema,
  RawQueryCollectionSchema,
  RawHasuraRestEndpointSchema,
} from '../config/schemas.js';

/** Generate documentation for all config schemas. */
export function generateConfigDocs(): ConfigDocsResult {
  return {
    schemas: [
      documentSchema('hakkyra.yaml (server config)', RawServerConfigSchema),
      documentSchema('databases.yaml', RawDatabasesYamlSchema),
      documentSchema('databases.yaml — database entry', RawDatabaseEntrySchema),
      documentSchema('Table YAML', RawTableYamlSchema),
      documentSchema('actions.yaml', RawActionsYamlSchema),
      documentSchema('actions.yaml — action entry', RawActionSchema),
      documentSchema('cron_triggers.yaml — trigger entry', RawCronTriggerSchema),
      documentSchema('functions.yaml — tracked function', RawTrackedFunctionSchema),
      documentSchema('query_collections.yaml — collection entry', RawQueryCollectionSchema),
      documentSchema('rest_endpoints.yaml — endpoint entry', RawHasuraRestEndpointSchema),
    ],
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderFieldMarkdown(field: FieldDoc, indent: number): string {
  const prefix = '  '.repeat(indent) + '- ';
  const parts: string[] = [];

  parts.push(`**\`${field.name}\`**`);
  parts.push(` *(${field.type})*`);

  if (!field.required) {
    parts.push(' — optional');
  }

  if (field.default !== undefined) {
    const defaultStr = typeof field.default === 'object'
      ? JSON.stringify(field.default)
      : String(field.default);
    parts.push(` — default: \`${defaultStr}\``);
  }

  if (field.enumValues) {
    parts.push(` — values: ${field.enumValues.map(v => `\`${v}\``).join(', ')}`);
  }

  if (field.description) {
    parts.push(`\n${'  '.repeat(indent + 1)}${field.description}`);
  }

  let result = prefix + parts.join('');

  if (field.children && field.children.length > 0) {
    result += '\n';
    result += field.children.map(child => renderFieldMarkdown(child, indent + 1)).join('\n');
  }

  return result;
}

function renderSchemaMarkdown(schema: SchemaDoc): string {
  const lines: string[] = [];

  lines.push(`### ${schema.name}`);
  if (schema.description) {
    lines.push('');
    lines.push(schema.description);
  }
  lines.push('');

  for (const field of schema.fields) {
    lines.push(renderFieldMarkdown(field, 0));
  }

  return lines.join('\n');
}

/** Render full config docs as Markdown. */
export function renderConfigDocsMarkdown(docs: ConfigDocsResult): string {
  const sections: string[] = [];

  sections.push('# Hakkyra Configuration Reference');
  sections.push('');
  sections.push('Auto-generated from Zod schema definitions.');
  sections.push('');

  for (const schema of docs.schemas) {
    sections.push(renderSchemaMarkdown(schema));
    sections.push('');
    sections.push('---');
    sections.push('');
  }

  return sections.join('\n').trimEnd() + '\n';
}

/** Render full config docs as JSON. */
export function renderConfigDocsJson(docs: ConfigDocsResult): string {
  return JSON.stringify(docs, null, 2) + '\n';
}
