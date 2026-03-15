import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { METADATA_DIR, SERVER_CONFIG_PATH, getCleanMetadataDir } from './setup.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let cleanDir: string;

beforeAll(async () => {
  cleanDir = await getCleanMetadataDir();
});

/** Create a temp metadata dir by copying the clean dir and applying modifications. */
async function createFixture(
  modify: (dir: string) => Promise<void>,
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hakkyra-unsupported-'));
  await fs.cp(cleanDir, tmpDir, { recursive: true });
  await modify(tmpDir);
  return tmpDir;
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── Unsupported metadata files ──────────────────────────────────────────────

describe('Unsupported Hasura Features', () => {
  describe('unsupported metadata files', () => {
    it('should succeed loading from fixture dir now that query_collections and rest_endpoints are supported', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config).toBeDefined();
      expect(config.queryCollections.length).toBeGreaterThan(0);
      expect(config.hasuraRestEndpoints.length).toBeGreaterThan(0);
    });

    for (const [baseName, label] of [
      ['remote_schemas', 'Remote schemas'],
      ['allowlist', 'Query allowlisting'],
      ['api_limits', 'API rate/depth limits'],
      ['opentelemetry', 'OpenTelemetry export'],
      ['network', 'Network/TLS configuration'],
      ['backend_configs', 'Backend-specific configuration'],
    ]) {
      it(`should error on ${baseName}.yaml`, async () => {
        const dir = await createFixture(async (d) => {
          await fs.writeFile(path.join(d, `${baseName}.yaml`), `- name: test\n`);
        });
        try {
          await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(baseName);
          await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
            /Unsupported Hasura features found/,
          );
        } finally {
          await cleanup(dir);
        }
      });

      it(`should error on ${baseName}.yml variant`, async () => {
        const dir = await createFixture(async (d) => {
          await fs.writeFile(path.join(d, `${baseName}.yml`), `- name: test\n`);
        });
        try {
          await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(baseName);
        } finally {
          await cleanup(dir);
        }
      });
    }

    it('should NOT error on empty unsupported files', async () => {
      const dir = await createFixture(async (d) => {
        await fs.writeFile(path.join(d, 'remote_schemas.yaml'), '');
        await fs.writeFile(path.join(d, 'allowlist.yaml'), '   \n\n  ');
        await fs.writeFile(path.join(d, 'api_limits.yaml'), '[]');
        await fs.writeFile(path.join(d, 'network.yaml'), '{}');
        await fs.writeFile(path.join(d, 'opentelemetry.yaml'), 'null');
      });
      try {
        const config = await loadConfig(dir, SERVER_CONFIG_PATH);
        expect(config).toBeDefined();
      } finally {
        await cleanup(dir);
      }
    });

    it('should report ALL unsupported files in a single error', async () => {
      const dir = await createFixture(async (d) => {
        await fs.writeFile(path.join(d, 'remote_schemas.yaml'), '- name: foo\n');
        await fs.writeFile(path.join(d, 'allowlist.yaml'), '- collection: bar\n');
        await fs.writeFile(path.join(d, 'api_limits.yaml'), 'depth_limit: 10\n');
      });
      try {
        await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /remote_schemas.*allowlist.*api_limits/s,
        );
      } finally {
        await cleanup(dir);
      }
    });
  });

  // ─── Unsupported table fields ──────────────────────────────────────────────

  describe('unsupported table fields', () => {
    it('should error on remote_relationships in table YAML', async () => {
      const dir = await createFixture(async (d) => {
        const tablePath = path.join(d, 'databases', 'default', 'tables', 'public_client.yaml');
        const content = await fs.readFile(tablePath, 'utf-8');
        const modified = content + '\nremote_relationships:\n  - name: remote_user\n    definition:\n      hasura_fields: [user_id]\n';
        await fs.writeFile(tablePath, modified);
      });
      try {
        await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /remote_relationships/,
        );
        await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /not supported by Hakkyra by design/,
        );
      } finally {
        await cleanup(dir);
      }
    });

    it('should error on apollo_federation_config in table YAML', async () => {
      const dir = await createFixture(async (d) => {
        const tablePath = path.join(d, 'databases', 'default', 'tables', 'public_client.yaml');
        const content = await fs.readFile(tablePath, 'utf-8');
        const modified = content + '\napollo_federation_config:\n  enable: v1\n';
        await fs.writeFile(tablePath, modified);
      });
      try {
        await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /apollo_federation_config/,
        );
        await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /not supported by Hakkyra by design/,
        );
      } finally {
        await cleanup(dir);
      }
    });

    it('should include table name in the error message', async () => {
      const dir = await createFixture(async (d) => {
        const tablePath = path.join(d, 'databases', 'default', 'tables', 'public_client.yaml');
        const content = await fs.readFile(tablePath, 'utf-8');
        const modified = content + '\nremote_relationships:\n  - name: test\n';
        await fs.writeFile(tablePath, modified);
      });
      try {
        await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /public\.client/,
        );
      } finally {
        await cleanup(dir);
      }
    });
  });

  // ─── Unsupported database fields ───────────────────────────────────────────

  describe('unsupported database fields', () => {
    for (const [field, label] of [
      ['stored_procedures', 'Stored procedures'],
      ['backend_configs', 'Backend-specific configuration'],
      ['customization', 'Database customization'],
    ]) {
      it(`should error on ${field} in database entry`, async () => {
        const dir = await createFixture(async (d) => {
          const dbPath = path.join(d, 'databases', 'databases.yaml');
          const content = await fs.readFile(dbPath, 'utf-8');
          const modified = content + `  ${field}:\n    - name: test\n`;
          await fs.writeFile(dbPath, modified);
        });
        try {
          await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(field);
          await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
            /Unsupported Hasura features found/,
          );
        } finally {
          await cleanup(dir);
        }
      });
    }

    it('should include database name in the error message', async () => {
      const dir = await createFixture(async (d) => {
        const dbPath = path.join(d, 'databases', 'databases.yaml');
        const content = await fs.readFile(dbPath, 'utf-8');
        const modified = content + '  stored_procedures:\n    - name: test\n';
        await fs.writeFile(dbPath, modified);
      });
      try {
        await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(
          /database "default"/,
        );
      } finally {
        await cleanup(dir);
      }
    });
  });

  // ─── Unsupported permission fields ─────────────────────────────────────────

  describe('unsupported permission fields', () => {
    it('should load query_root_fields in select permission (now supported)', async () => {
      const dir = await createFixture(async (d) => {
        // Create a standalone table file to avoid YAML duplicate key issues
        const tableFile = `table:
  schema: public
  name: perm_test
select_permissions:
  - role: test_role
    permission:
      columns: "*"
      filter: {}
      query_root_fields: ["select", "select_by_pk"]
`;
        await fs.writeFile(path.join(d, 'databases', 'default', 'tables', 'public_perm_test.yaml'), tableFile);
        // Add to tables.yaml
        const tablesYaml = path.join(d, 'databases', 'default', 'tables', 'tables.yaml');
        const existing = await fs.readFile(tablesYaml, 'utf-8');
        await fs.writeFile(tablesYaml, existing + '- !include public_perm_test.yaml\n');
      });
      try {
        const config = await loadConfig(dir, SERVER_CONFIG_PATH);
        const table = config.tables.find((t) => t.name === 'perm_test');
        expect(table).toBeDefined();
        expect(table!.permissions.select['test_role'].queryRootFields).toEqual(['select', 'select_by_pk']);
      } finally {
        await cleanup(dir);
      }
    });

    it('should load subscription_root_fields in select permission (now supported)', async () => {
      const dir = await createFixture(async (d) => {
        const tableFile = `table:
  schema: public
  name: perm_test
select_permissions:
  - role: test_role
    permission:
      columns: "*"
      filter: {}
      subscription_root_fields: ["select", "select_stream"]
`;
        await fs.writeFile(path.join(d, 'databases', 'default', 'tables', 'public_perm_test.yaml'), tableFile);
        const tablesYaml = path.join(d, 'databases', 'default', 'tables', 'tables.yaml');
        const existing = await fs.readFile(tablesYaml, 'utf-8');
        await fs.writeFile(tablesYaml, existing + '- !include public_perm_test.yaml\n');
      });
      try {
        const config = await loadConfig(dir, SERVER_CONFIG_PATH);
        const table = config.tables.find((t) => t.name === 'perm_test');
        expect(table).toBeDefined();
        expect(table!.permissions.select['test_role'].subscriptionRootFields).toEqual(['select', 'select_stream']);
      } finally {
        await cleanup(dir);
      }
    });

    it('should load empty query_root_fields and subscription_root_fields', async () => {
      const dir = await createFixture(async (d) => {
        const tableFile = `table:
  schema: public
  name: perm_test
select_permissions:
  - role: test_role
    permission:
      columns: "*"
      filter: {}
      query_root_fields: []
      subscription_root_fields: []
`;
        await fs.writeFile(path.join(d, 'databases', 'default', 'tables', 'public_perm_test.yaml'), tableFile);
        const tablesYaml = path.join(d, 'databases', 'default', 'tables', 'tables.yaml');
        const existing = await fs.readFile(tablesYaml, 'utf-8');
        await fs.writeFile(tablesYaml, existing + '- !include public_perm_test.yaml\n');
      });
      try {
        const config = await loadConfig(dir, SERVER_CONFIG_PATH);
        const table = config.tables.find((t) => t.name === 'perm_test');
        expect(table).toBeDefined();
        expect(table!.permissions.select['test_role'].queryRootFields).toEqual([]);
        expect(table!.permissions.select['test_role'].subscriptionRootFields).toEqual([]);
      } finally {
        await cleanup(dir);
      }
    });

    it('should leave queryRootFields undefined when not specified', async () => {
      const dir = await createFixture(async (d) => {
        const tableFile = `table:
  schema: public
  name: perm_test
select_permissions:
  - role: test_role
    permission:
      columns: "*"
      filter: {}
`;
        await fs.writeFile(path.join(d, 'databases', 'default', 'tables', 'public_perm_test.yaml'), tableFile);
        const tablesYaml = path.join(d, 'databases', 'default', 'tables', 'tables.yaml');
        const existing = await fs.readFile(tablesYaml, 'utf-8');
        await fs.writeFile(tablesYaml, existing + '- !include public_perm_test.yaml\n');
      });
      try {
        const config = await loadConfig(dir, SERVER_CONFIG_PATH);
        const table = config.tables.find((t) => t.name === 'perm_test');
        expect(table).toBeDefined();
        expect(table!.permissions.select['test_role'].queryRootFields).toBeUndefined();
        expect(table!.permissions.select['test_role'].subscriptionRootFields).toBeUndefined();
      } finally {
        await cleanup(dir);
      }
    });

    it('should warn and ignore validate_input in update permission', async () => {
      const dir = await createFixture(async (d) => {
        const tableFile = `table:
  schema: public
  name: perm_test
update_permissions:
  - role: test_role
    permission:
      columns: "*"
      filter: {}
      validate_input:
        type: http
        definition:
          url: http://localhost:3000/validate
`;
        await fs.writeFile(path.join(d, 'databases', 'default', 'tables', 'public_perm_test.yaml'), tableFile);
        const tablesYaml = path.join(d, 'databases', 'default', 'tables', 'tables.yaml');
        const existing = await fs.readFile(tablesYaml, 'utf-8');
        await fs.writeFile(tablesYaml, existing + '- !include public_perm_test.yaml\n');
      });
      try {
        // Should not throw — validate_input is ignored with a warning
        const config = await loadConfig(dir, SERVER_CONFIG_PATH);
        expect(config).toBeDefined();
      } finally {
        await cleanup(dir);
      }
    });
  });

  // ─── Combined unsupported features ─────────────────────────────────────────

  describe('combined unsupported features', () => {
    it('should report unsupported files, table fields, and database fields together', async () => {
      const dir = await createFixture(async (d) => {
        // Unsupported file
        await fs.writeFile(path.join(d, 'remote_schemas.yaml'), '- name: foo\n');
        // Unsupported table field
        const tablePath = path.join(d, 'databases', 'default', 'tables', 'public_client.yaml');
        const tableContent = await fs.readFile(tablePath, 'utf-8');
        await fs.writeFile(tablePath, tableContent + '\nremote_relationships:\n  - name: test\n');
        // Unsupported database field
        const dbPath = path.join(d, 'databases', 'databases.yaml');
        const dbContent = await fs.readFile(dbPath, 'utf-8');
        await fs.writeFile(dbPath, dbContent + '  stored_procedures:\n    - name: test\n');
      });
      try {
        const err = await loadConfig(dir, SERVER_CONFIG_PATH).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        const msg = (err as Error).message;
        expect(msg).toContain('remote_schemas.yaml');
        expect(msg).toContain('remote_relationships');
        expect(msg).toContain('stored_procedures');
      } finally {
        await cleanup(dir);
      }
    });
  });
});

// ─── Strict validation (unknown fields) ───────────────────────────────────

describe('unknown fields in YAML configs (strict mode)', () => {
  it('should error on unknown field in table YAML', async () => {
    const dir = await createFixture(async (d) => {
      const tablePath = path.join(d, 'databases', 'default', 'tables', 'public_client.yaml');
      const content = await fs.readFile(tablePath, 'utf-8');
      const modified = content + '\nunknown_field: true\n';
      await fs.writeFile(tablePath, modified);
    });
    try {
      await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(/Unrecognized key/i);
    } finally {
      await cleanup(dir);
    }
  });

  it('should error on unknown field in database YAML', async () => {
    const dir = await createFixture(async (d) => {
      const dbPath = path.join(d, 'databases', 'databases.yaml');
      const content = await fs.readFile(dbPath, 'utf-8');
      // Append unknown field inside the first database entry (indented under the array element)
      const modified = content + '  unknown_db_field: true\n';
      await fs.writeFile(dbPath, modified);
    });
    try {
      await expect(loadConfig(dir, SERVER_CONFIG_PATH)).rejects.toThrow(/Unrecognized key/i);
    } finally {
      await cleanup(dir);
    }
  });

  it('should error on unknown field in server config (hakkyra.yaml)', async () => {
    const tmpConfig = path.join(os.tmpdir(), `hakkyra-strict-test-${Date.now()}.yaml`);
    await fs.writeFile(tmpConfig, 'server:\n  port: 3000\nunknown_section:\n  foo: bar\n');
    try {
      await expect(loadConfig(METADATA_DIR, tmpConfig)).rejects.toThrow(/Unrecognized key/i);
    } finally {
      await fs.rm(tmpConfig, { force: true });
    }
  });
});
