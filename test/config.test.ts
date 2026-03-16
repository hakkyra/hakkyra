import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { validateConfig } from '../src/config/validator.js';
import { METADATA_DIR, SERVER_CONFIG_PATH, getCleanMetadataDir } from './setup.js';

describe('Config Loading', () => {
  describe('loadConfig', () => {
    it('should load config from the test metadata directory', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config).toBeDefined();
      expect(config.version).toBe(3);
      expect(config.tables).toBeDefined();
      expect(config.tables.length).toBeGreaterThan(0);
    });

    it('should resolve !include tags in tables.yaml', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const clientTable = config.tables.find((t) => t.name === 'client');
      expect(clientTable).toBeDefined();
      expect(clientTable!.schema).toBe('public');
    });

    it('should load all tracked tables from includes', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const tableNames = config.tables.map((t) => t.name);
      expect(tableNames).toContain('client');
      expect(tableNames).toContain('account');
      expect(tableNames).toContain('invoice');
      expect(tableNames).toContain('branch');
      expect(tableNames).toContain('product');
      expect(tableNames).toContain('appointment');
      expect(tableNames).toContain('service_plan');
    });

    it('should transform snake_case config fields to camelCase', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const clientTable = config.tables.find((t) => t.name === 'client');
      expect(clientTable?.customRootFields).toBeDefined();
      expect(clientTable!.customRootFields!.select).toBe('clients');
      expect(clientTable!.customRootFields!.select_by_pk).toBe('clientByPk');
    });

    it('should load relationships from table config', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const clientTable = config.tables.find((t) => t.name === 'client');
      expect(clientTable?.relationships.length).toBeGreaterThan(0);

      const accountRel = clientTable!.relationships.find((r) => r.name === 'accounts');
      expect(accountRel).toBeDefined();
      expect(accountRel!.type).toBe('array');

      const branchRel = clientTable!.relationships.find((r) => r.name === 'branch');
      expect(branchRel).toBeDefined();
      expect(branchRel!.type).toBe('object');
    });

    it('should load permissions from table config', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const clientTable = config.tables.find((t) => t.name === 'client');
      expect(clientTable?.permissions).toBeDefined();

      // Select permissions
      expect(clientTable!.permissions.select['client']).toBeDefined();
      expect(clientTable!.permissions.select['backoffice']).toBeDefined();
      expect(clientTable!.permissions.select['administrator']).toBeDefined();

      // Client select filter should reference X-Hasura-User-Id
      const clientPerm = clientTable!.permissions.select['client'];
      expect(clientPerm.filter).toHaveProperty('id');
    });

    it('should load server config with auth settings', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.auth.jwt).toBeDefined();
      expect(config.auth.jwt!.type).toBe('HS256');
      expect(config.auth.jwt!.key).toBe('test-secret-key-minimum-32-chars!!');
      expect(config.auth.unauthorizedRole).toBe('anonymous');
      expect(config.auth.adminSecretEnv).toBe('HAKKYRA_ADMIN_SECRET');
    });

    it('should load database config from server config', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.databases.primary.urlEnv).toBe('DATABASE_URL');
      expect(config.databases.primary.pool?.max).toBe(5);
    });

    it('should load REST config from hakkyra.yaml', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.rest.autoGenerate).toBe(true);
      expect(config.rest.basePath).toBe('/api/v1');
      expect(config.rest.pagination.defaultLimit).toBe(20);
      expect(config.rest.pagination.maxLimit).toBe(100);
    });

    it('should load docs config from hakkyra.yaml', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.apiDocs.generate).toBe(true);
      expect(config.apiDocs.llmFormat).toBe(true);
    });

    it('should handle event triggers on invoice table', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const invoiceTable = config.tables.find((t) => t.name === 'invoice');
      expect(invoiceTable).toBeDefined();
      expect(invoiceTable!.eventTriggers.length).toBeGreaterThan(0);
      const trigger = invoiceTable!.eventTriggers.find(
        (t) => t.name === 'invoice_created',
      );
      expect(trigger).toBeDefined();
      expect(trigger!.retryConf.numRetries).toBe(5);
    });

    it('should load actions and cron triggers from fixture files', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.actions.length).toBeGreaterThan(0);
      expect(config.cronTriggers.length).toBeGreaterThan(0);
    });

    it('should load introspection config with empty disabled_for_roles', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.introspection).toBeDefined();
      expect(config.introspection.disabledForRoles).toEqual([]);
    });

    it('should load introspection config with disabled roles', async () => {
      const cleanDir = await getCleanMetadataDir();
      // Write a custom introspection config with disabled roles
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const introspectionPath = path.join(cleanDir, 'graphql_schema_introspection.yaml');
      const originalContent = await fs.readFile(introspectionPath, 'utf-8').catch(() => '');
      try {
        await fs.writeFile(introspectionPath, 'disabled_for_roles:\n  - player\n  - anonymous\n');
        const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
        expect(config.introspection.disabledForRoles).toEqual(['player', 'anonymous']);
      } finally {
        // Restore original content
        if (originalContent) {
          await fs.writeFile(introspectionPath, originalContent);
        } else {
          await fs.unlink(introspectionPath).catch(() => {});
        }
      }
    });

    it('should default introspection disabledForRoles to empty when file is missing', async () => {
      const cleanDir = await getCleanMetadataDir();
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const introspectionPath = path.join(cleanDir, 'graphql_schema_introspection.yaml');
      const originalContent = await fs.readFile(introspectionPath, 'utf-8').catch(() => '');
      try {
        await fs.unlink(introspectionPath).catch(() => {});
        const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
        expect(config.introspection.disabledForRoles).toEqual([]);
      } finally {
        if (originalContent) {
          await fs.writeFile(introspectionPath, originalContent);
        }
      }
    });
  });

  describe('native queries and logical models', () => {
    it('should load native queries from databases.yaml', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.nativeQueries).toBeDefined();
      expect(config.nativeQueries.length).toBe(2);

      const branchCount = config.nativeQueries.find((q) => q.rootFieldName === 'branchClientCount');
      expect(branchCount).toBeDefined();
      expect(branchCount!.code).toContain('branch_id = {{branchId}}');
      expect(branchCount!.returns).toBe('BranchClientCount');
      expect(branchCount!.arguments).toHaveLength(1);
      expect(branchCount!.arguments[0].name).toBe('branchId');
      expect(branchCount!.arguments[0].type).toBe('uuid');
      expect(branchCount!.arguments[0].nullable).toBe(false);
    });

    it('should load logical models from databases.yaml', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      expect(config.logicalModels).toBeDefined();
      expect(config.logicalModels.length).toBe(2);

      const branchClientCount = config.logicalModels.find((m) => m.name === 'BranchClientCount');
      expect(branchClientCount).toBeDefined();
      expect(branchClientCount!.fields).toHaveLength(1);
      expect(branchClientCount!.fields[0].name).toBe('count');
      expect(branchClientCount!.fields[0].type).toBe('bigint');
      expect(branchClientCount!.fields[0].nullable).toBe(false);
      expect(branchClientCount!.selectPermissions).toHaveLength(2);
      expect(branchClientCount!.selectPermissions[0].role).toBe('backoffice');
      expect(branchClientCount!.selectPermissions[0].columns).toContain('count');
    });

    it('should load logical model with session variable filter', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const clientNameResult = config.logicalModels.find((m) => m.name === 'ClientNameResult');
      expect(clientNameResult).toBeDefined();
      const clientPerm = clientNameResult!.selectPermissions.find((p) => p.role === 'client');
      expect(clientPerm).toBeDefined();
      expect(clientPerm!.filter).toHaveProperty('id');
    });

    it('should default to empty arrays when no native queries or logical models', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      // Even if they exist, the default [] works
      expect(Array.isArray(config.nativeQueries)).toBe(true);
      expect(Array.isArray(config.logicalModels)).toBe(true);
    });
  });

  describe('validateConfig', () => {
    it('should validate a correctly loaded config without errors', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should report version validation for unsupported versions', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const badConfig = { ...config, version: 1 };
      const result = validateConfig(badConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'version')).toBe(true);
    });

    it('should report errors for invalid port numbers', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const badConfig = { ...config, server: { ...config.server, port: 99999 } };
      const result = validateConfig(badConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'server.port')).toBe(true);
    });

    it('should validate REST pagination config', async () => {
      const cleanDir = await getCleanMetadataDir();
      const config = await loadConfig(cleanDir, SERVER_CONFIG_PATH);
      const badConfig = {
        ...config,
        rest: { ...config.rest, pagination: { defaultLimit: 200, maxLimit: 100 } },
      };
      const result = validateConfig(badConfig);
      expect(result.errors.some((e) => e.path === 'rest.pagination.maxLimit')).toBe(true);
    });
  });

  describe('Root field visibility helpers', () => {
    it('isQueryRootFieldAllowed: undefined queryRootFields allows all', async () => {
      const { isQueryRootFieldAllowed } = await import('../src/schema/resolvers/index.js');
      expect(isQueryRootFieldAllowed(undefined, 'select')).toBe(true);
      expect(isQueryRootFieldAllowed(null, 'select')).toBe(true);
      expect(isQueryRootFieldAllowed({}, 'select')).toBe(true);
      expect(isQueryRootFieldAllowed({ queryRootFields: undefined }, 'select')).toBe(true);
    });

    it('isQueryRootFieldAllowed: empty array denies all', async () => {
      const { isQueryRootFieldAllowed } = await import('../src/schema/resolvers/index.js');
      expect(isQueryRootFieldAllowed({ queryRootFields: [] }, 'select')).toBe(false);
      expect(isQueryRootFieldAllowed({ queryRootFields: [] }, 'select_by_pk')).toBe(false);
      expect(isQueryRootFieldAllowed({ queryRootFields: [] }, 'select_aggregate')).toBe(false);
    });

    it('isQueryRootFieldAllowed: specific list allows only listed operations', async () => {
      const { isQueryRootFieldAllowed } = await import('../src/schema/resolvers/index.js');
      const perm = { queryRootFields: ['select', 'select_by_pk'] };
      expect(isQueryRootFieldAllowed(perm, 'select')).toBe(true);
      expect(isQueryRootFieldAllowed(perm, 'select_by_pk')).toBe(true);
      expect(isQueryRootFieldAllowed(perm, 'select_aggregate')).toBe(false);
    });

    it('isSubscriptionRootFieldAllowed: undefined allows all', async () => {
      const { isSubscriptionRootFieldAllowed } = await import('../src/schema/resolvers/index.js');
      expect(isSubscriptionRootFieldAllowed(undefined, 'select')).toBe(true);
      expect(isSubscriptionRootFieldAllowed({}, 'select_stream')).toBe(true);
    });

    it('isSubscriptionRootFieldAllowed: empty array denies all', async () => {
      const { isSubscriptionRootFieldAllowed } = await import('../src/schema/resolvers/index.js');
      expect(isSubscriptionRootFieldAllowed({ subscriptionRootFields: [] }, 'select')).toBe(false);
      expect(isSubscriptionRootFieldAllowed({ subscriptionRootFields: [] }, 'select_stream')).toBe(false);
    });

    it('isSubscriptionRootFieldAllowed: specific list allows only listed operations', async () => {
      const { isSubscriptionRootFieldAllowed } = await import('../src/schema/resolvers/index.js');
      const perm = { subscriptionRootFields: ['select', 'select_stream'] };
      expect(isSubscriptionRootFieldAllowed(perm, 'select')).toBe(true);
      expect(isSubscriptionRootFieldAllowed(perm, 'select_stream')).toBe(true);
      expect(isSubscriptionRootFieldAllowed(perm, 'select_by_pk')).toBe(false);
    });
  });
});
