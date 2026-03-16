import { describe, it, expect } from 'vitest';
import {
  documentSchema,
  generateConfigDocs,
  renderConfigDocsMarkdown,
  renderConfigDocsJson,
} from '../src/docs/config-docs.js';
import type { SchemaDoc, FieldDoc, ConfigDocsResult } from '../src/docs/config-docs.js';
import { z } from 'zod';

// ─── documentSchema unit tests ──────────────────────────────────────────────

describe('documentSchema', () => {
  it('documents a simple object schema', () => {
    const schema = z.object({
      name: z.string().describe('The name'),
      age: z.number().optional().describe('The age'),
    });

    const doc = documentSchema('TestSchema', schema);

    expect(doc.name).toBe('TestSchema');
    expect(doc.fields).toHaveLength(2);

    const nameField = doc.fields.find(f => f.name === 'name')!;
    expect(nameField.type).toBe('string');
    expect(nameField.required).toBe(true);
    expect(nameField.description).toBe('The name');

    const ageField = doc.fields.find(f => f.name === 'age')!;
    expect(ageField.type).toBe('number');
    expect(ageField.required).toBe(false);
    expect(ageField.description).toBe('The age');
  });

  it('extracts default values', () => {
    const schema = z.object({
      port: z.number().default(3000).describe('Server port'),
      host: z.string().default('0.0.0.0').describe('Server host'),
    });

    const doc = documentSchema('Defaults', schema);

    const portField = doc.fields.find(f => f.name === 'port')!;
    expect(portField.default).toBe(3000);
    expect(portField.required).toBe(false);

    const hostField = doc.fields.find(f => f.name === 'host')!;
    expect(hostField.default).toBe('0.0.0.0');
  });

  it('extracts enum values', () => {
    const schema = z.object({
      mode: z.enum(['GET', 'POST']).describe('HTTP method'),
    });

    const doc = documentSchema('Enums', schema);

    const modeField = doc.fields.find(f => f.name === 'mode')!;
    expect(modeField.enumValues).toEqual(['GET', 'POST']);
    expect(modeField.type).toContain('"GET"');
    expect(modeField.type).toContain('"POST"');
  });

  it('recurses into nested objects', () => {
    const schema = z.object({
      server: z.object({
        port: z.number().describe('Port'),
        host: z.string().describe('Host'),
      }).describe('Server config'),
    });

    const doc = documentSchema('Nested', schema);

    const serverField = doc.fields.find(f => f.name === 'server')!;
    expect(serverField.type).toBe('object');
    expect(serverField.children).toBeDefined();
    expect(serverField.children).toHaveLength(2);
    expect(serverField.children!.find(f => f.name === 'port')).toBeDefined();
    expect(serverField.children!.find(f => f.name === 'host')).toBeDefined();
  });

  it('recurses into arrays of objects', () => {
    const schema = z.object({
      items: z.array(z.object({
        id: z.number().describe('Item ID'),
        label: z.string().describe('Item label'),
      })).describe('List of items'),
    });

    const doc = documentSchema('ArrayOfObjects', schema);

    const itemsField = doc.fields.find(f => f.name === 'items')!;
    expect(itemsField.type).toBe('object[]');
    expect(itemsField.children).toBeDefined();
    expect(itemsField.children).toHaveLength(2);
  });

  it('handles union types', () => {
    const schema = z.object({
      value: z.union([z.string(), z.number()]).describe('A union'),
    });

    const doc = documentSchema('Union', schema);

    const valueField = doc.fields.find(f => f.name === 'value')!;
    expect(valueField.type).toBe('string | number');
  });

  it('handles nullable types', () => {
    const schema = z.object({
      name: z.string().nullable().describe('Nullable name'),
    });

    const doc = documentSchema('Nullable', schema);

    const nameField = doc.fields.find(f => f.name === 'name')!;
    expect(nameField.required).toBe(false);
  });

  it('preserves description from outer wrapper', () => {
    const schema = z.object({
      port: z.number().optional().describe('The port'),
    });

    const doc = documentSchema('DescTest', schema);

    const portField = doc.fields.find(f => f.name === 'port')!;
    expect(portField.description).toBe('The port');
  });

  it('handles record types', () => {
    const schema = z.object({
      headers: z.record(z.string(), z.string()).describe('HTTP headers'),
    });

    const doc = documentSchema('Records', schema);

    const headersField = doc.fields.find(f => f.name === 'headers')!;
    expect(headersField.type).toBe('Record<string, string>');
  });

  it('captures schema-level description', () => {
    const schema = z.object({
      x: z.number(),
    }).describe('A described schema');

    const doc = documentSchema('Described', schema);
    expect(doc.description).toBe('A described schema');
  });
});

// ─── generateConfigDocs ─────────────────────────────────────────────────────

describe('generateConfigDocs', () => {
  it('returns docs for all expected config schemas', () => {
    const docs = generateConfigDocs();

    expect(docs.schemas.length).toBeGreaterThanOrEqual(10);

    const names = docs.schemas.map(s => s.name);
    expect(names).toContain('hakkyra.yaml (server config)');
    expect(names).toContain('databases.yaml');
    expect(names).toContain('Table YAML');
    expect(names).toContain('actions.yaml');
    expect(names).toContain('cron_triggers.yaml — trigger entry');
    expect(names).toContain('functions.yaml — tracked function');
    expect(names).toContain('query_collections.yaml — collection entry');
    expect(names).toContain('rest_endpoints.yaml — endpoint entry');
  });

  it('all schemas have at least one field', () => {
    const docs = generateConfigDocs();

    for (const schema of docs.schemas) {
      expect(schema.fields.length).toBeGreaterThan(0);
    }
  });

  it('all leaf fields have descriptions', () => {
    const docs = generateConfigDocs();

    function checkDescriptions(fields: FieldDoc[], path: string): void {
      for (const field of fields) {
        const fieldPath = `${path}.${field.name}`;
        // Every field should have a description since we added .describe() to all fields
        expect(field.description, `Missing description at ${fieldPath}`).toBeTruthy();
        if (field.children) {
          checkDescriptions(field.children, fieldPath);
        }
      }
    }

    for (const schema of docs.schemas) {
      checkDescriptions(schema.fields, schema.name);
    }
  });
});

// ─── Markdown rendering ─────────────────────────────────────────────────────

describe('renderConfigDocsMarkdown', () => {
  it('produces valid Markdown with expected headers', () => {
    const docs = generateConfigDocs();
    const md = renderConfigDocsMarkdown(docs);

    expect(md).toContain('# Hakkyra Configuration Reference');
    expect(md).toContain('### hakkyra.yaml (server config)');
    expect(md).toContain('### databases.yaml');
    expect(md).toContain('### Table YAML');
    expect(md).toContain('### actions.yaml');
  });

  it('includes field details in Markdown', () => {
    const docs: ConfigDocsResult = {
      schemas: [
        documentSchema('Test', z.object({
          port: z.number().default(3000).describe('Server port'),
        })),
      ],
    };

    const md = renderConfigDocsMarkdown(docs);

    expect(md).toContain('**`port`**');
    expect(md).toContain('*(number)*');
    expect(md).toContain('default: `3000`');
    expect(md).toContain('Server port');
  });

  it('ends with a newline', () => {
    const docs = generateConfigDocs();
    const md = renderConfigDocsMarkdown(docs);
    expect(md.endsWith('\n')).toBe(true);
  });
});

// ─── JSON rendering ─────────────────────────────────────────────────────────

describe('renderConfigDocsJson', () => {
  it('produces valid JSON', () => {
    const docs = generateConfigDocs();
    const jsonStr = renderConfigDocsJson(docs);
    const parsed = JSON.parse(jsonStr);

    expect(parsed).toHaveProperty('schemas');
    expect(Array.isArray(parsed.schemas)).toBe(true);
    expect(parsed.schemas.length).toBeGreaterThanOrEqual(10);
  });

  it('round-trips through JSON parse', () => {
    const docs = generateConfigDocs();
    const jsonStr = renderConfigDocsJson(docs);
    const parsed = JSON.parse(jsonStr) as ConfigDocsResult;

    // Check that field structure survives serialization
    const serverConfig = parsed.schemas.find(s => s.name.includes('hakkyra.yaml'));
    expect(serverConfig).toBeDefined();
    expect(serverConfig!.fields.length).toBeGreaterThan(0);
  });

  it('ends with a newline', () => {
    const docs = generateConfigDocs();
    const json = renderConfigDocsJson(docs);
    expect(json.endsWith('\n')).toBe(true);
  });
});
