import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { validateConfig } from '../src/config/validator.js';
import { METADATA_DIR, SERVER_CONFIG_PATH } from './setup.js';

describe('Config Loading', () => {
  describe('loadConfig', () => {
    it('should load config from the test metadata directory', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config).toBeDefined();
      expect(config.version).toBe(3);
      expect(config.tables).toBeDefined();
      expect(config.tables.length).toBeGreaterThan(0);
    });

    it('should resolve !include tags in tables.yaml', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const clientTable = config.tables.find((t) => t.name === 'client');
      expect(clientTable).toBeDefined();
      expect(clientTable!.schema).toBe('public');
    });

    it('should load all tracked tables from includes', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
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
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const clientTable = config.tables.find((t) => t.name === 'client');
      expect(clientTable?.customRootFields).toBeDefined();
      expect(clientTable!.customRootFields!.select).toBe('clients');
      expect(clientTable!.customRootFields!.select_by_pk).toBe('clientByPk');
    });

    it('should load relationships from table config', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
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
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
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
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config.auth.jwt).toBeDefined();
      expect(config.auth.jwt!.type).toBe('HS256');
      expect(config.auth.jwt!.key).toBe('test-secret-key-minimum-32-chars!!');
      expect(config.auth.unauthorizedRole).toBe('anonymous');
      expect(config.auth.adminSecretEnv).toBe('HAKKYRA_ADMIN_SECRET');
    });

    it('should load database config from server config', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config.databases.primary.urlEnv).toBe('DATABASE_URL');
      expect(config.databases.primary.pool?.max).toBe(5);
    });

    it('should load REST config from api_config.yaml', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config.rest.autoGenerate).toBe(true);
      expect(config.rest.basePath).toBe('/api/v1');
      expect(config.rest.pagination.defaultLimit).toBe(20);
      expect(config.rest.pagination.maxLimit).toBe(100);
    });

    it('should load docs config from api_config.yaml', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config.apiDocs.generate).toBe(true);
      expect(config.apiDocs.llmFormat).toBe(true);
    });

    it('should load custom queries from api_config.yaml', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config.customQueries).toBeDefined();
      expect(config.customQueries.length).toBe(3);

      const cwb = config.customQueries.find((q) => q.name === 'getClientWithBalance');
      expect(cwb).toBeDefined();
      expect(cwb!.type).toBe('query');
      expect(cwb!.params).toHaveLength(1);
      expect(cwb!.params![0].name).toBe('clientId');
      expect(cwb!.params![0].type).toBe('uuid');
      expect(cwb!.returns).toBe('ClientWithBalance');
      expect(cwb!.permissions).toHaveLength(3);
    });

    it('should load custom mutation from api_config.yaml', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const ca = config.customQueries.find((q) => q.name === 'creditAccount');
      expect(ca).toBeDefined();
      expect(ca!.type).toBe('mutation');
      expect(ca!.params).toHaveLength(2);
      expect(ca!.returns).toBe('AccountBalance');
    });

    it('should load custom query permissions with filters', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const cwb = config.customQueries.find((q) => q.name === 'getClientWithBalance');
      const functionPerm = cwb!.permissions!.find((p) => p.role === 'function');
      expect(functionPerm).toBeDefined();
      expect(functionPerm!.filter).toBeDefined();
    });

    it('should handle event triggers on invoice table', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
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
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      expect(config.actions.length).toBeGreaterThan(0);
      expect(config.cronTriggers.length).toBeGreaterThan(0);
    });
  });

  describe('validateConfig', () => {
    it('should validate a correctly loaded config without errors', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should report version validation for unsupported versions', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const badConfig = { ...config, version: 1 };
      const result = validateConfig(badConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'version')).toBe(true);
    });

    it('should report errors for invalid port numbers', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const badConfig = { ...config, server: { ...config.server, port: 99999 } };
      const result = validateConfig(badConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === 'server.port')).toBe(true);
    });

    it('should validate REST pagination config', async () => {
      const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
      const badConfig = {
        ...config,
        rest: { ...config.rest, pagination: { defaultLimit: 200, maxLimit: 100 } },
      };
      const result = validateConfig(badConfig);
      expect(result.errors.some((e) => e.path === 'rest.pagination.maxLimit')).toBe(true);
    });
  });
});
