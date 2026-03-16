import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema, GraphQLObjectType, GraphQLInputObjectType, GraphQLNonNull, GraphQLList } from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel } from '../src/types.js';
import { getPool, closePool, waitForDb, METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL } from './setup.js';

let schemaModel: SchemaModel;
let schema: GraphQLSchema;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  const config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  schema = generateSchema(schemaModel);
});

afterAll(async () => {
  await closePool();
});

describe('GraphQL Schema Generation', () => {
  it('should generate a valid GraphQLSchema', () => {
    expect(schema).toBeInstanceOf(GraphQLSchema);
  });

  describe('query_root type', () => {
    it('should have a query_root type', () => {
      const queryType = schema.getQueryType();
      expect(queryType).toBeDefined();
    });

    it('should have custom root field names for client table', () => {
      const queryType = schema.getQueryType()!;
      const fields = queryType.getFields();
      expect(fields['clients']).toBeDefined();
      expect(fields['clientByPk']).toBeDefined();
      expect(fields['clientsAggregate']).toBeDefined();
    });

    it('should have select fields for tracked tables', () => {
      const queryType = schema.getQueryType()!;
      const fieldNames = Object.keys(queryType.getFields());
      expect(fieldNames.some((n) => n.toLowerCase().includes('branch'))).toBe(true);
      expect(fieldNames.some((n) => n.toLowerCase().includes('account'))).toBe(true);
    });

    it('should have select_by_pk fields for tables with PKs', () => {
      const queryType = schema.getQueryType()!;
      const fields = queryType.getFields();
      expect(fields['clientByPk']).toBeDefined();
    });

    it('should have aggregate fields for tables', () => {
      const queryType = schema.getQueryType()!;
      const fields = queryType.getFields();
      expect(fields['clientsAggregate']).toBeDefined();
    });

    it('should have where, orderBy, limit, offset args on list fields', () => {
      const queryType = schema.getQueryType()!;
      const clientsField = queryType.getFields()['clients'];
      expect(clientsField).toBeDefined();
      const argNames = clientsField.args.map((a) => a.name);
      expect(argNames).toContain('where');
      expect(argNames).toContain('orderBy');
      expect(argNames).toContain('limit');
      expect(argNames).toContain('offset');
    });
  });

  describe('mutation_root type', () => {
    it('should have a mutation_root type', () => {
      const mutationType = schema.getMutationType();
      expect(mutationType).toBeDefined();
    });

    it('should have insert fields', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      expect(fields['insertClients']).toBeDefined();
      expect(fields['insertClient']).toBeDefined();
    });

    it('should have update fields', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      expect(fields['updateClients']).toBeDefined();
      expect(fields['updateClientByPk']).toBeDefined();
    });

    it('should have delete fields', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      expect(fields['deleteClients']).toBeDefined();
      expect(fields['deleteClientByPk']).toBeDefined();
    });

    it('should have insert objects arg as required list', () => {
      const mutationType = schema.getMutationType()!;
      const insertField = mutationType.getFields()['insertClients'];
      const objectsArg = insertField.args.find((a) => a.name === 'objects');
      expect(objectsArg).toBeDefined();
      expect(objectsArg!.type).toBeInstanceOf(GraphQLNonNull);
    });
  });

  describe('subscription_root type', () => {
    it('should have a subscription_root type', () => {
      const subscriptionType = schema.getSubscriptionType();
      expect(subscriptionType).toBeDefined();
    });

    it('should have select subscription fields', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      expect(fields['clients']).toBeDefined();
    });

    it('should have by-PK subscription fields', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      expect(fields['clientByPk']).toBeDefined();
    });
  });

  describe('Object types', () => {
    it('should generate Client type with correct fields', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType | undefined;
      expect(clientType).toBeDefined();
      const fields = clientType!.getFields();
      expect(fields['id']).toBeDefined();
      expect(fields['username']).toBeDefined();
      expect(fields['email']).toBeDefined();
    });

    it('should have relationship fields on Client type', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      expect(fields['accounts']).toBeDefined();
      expect(fields['branch']).toBeDefined();
      expect(fields['invoices']).toBeDefined();
    });

    it('should have array relationships as non-null list types', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const accountsField = clientType.getFields()['accounts'];
      expect(accountsField.type).toBeInstanceOf(GraphQLNonNull);
    });
  });

  describe('Custom scalars', () => {
    it('should register Uuid scalar type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['Uuid']).toBeDefined();
    });

    it('should register Timestamptz scalar type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['Timestamptz']).toBeDefined();
    });

    it('should register json scalar type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['json']).toBeDefined();
    });

    it('should register Numeric scalar type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['Numeric']).toBeDefined();
    });
  });

  describe('Enum types', () => {
    it('should generate GraphQL enum types from PG enums', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['ClientStatus']).toBeDefined();
      expect(typeMap['InvoiceState']).toBeDefined();
      expect(typeMap['LedgerType']).toBeDefined();
    });
  });

  describe('Statistical aggregate types', () => {
    it('should generate StddevFields type for tables with numeric columns', () => {
      const typeMap = schema.getTypeMap();
      const stddevType = typeMap['AccountStddevFields'] as GraphQLObjectType | undefined;
      expect(stddevType).toBeDefined();
      const fields = stddevType!.getFields();
      expect(fields['balance']).toBeDefined();
    });

    it('should generate StddevPopFields type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['AccountStddevPopFields']).toBeDefined();
    });

    it('should generate StddevSampFields type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['AccountStddevSampFields']).toBeDefined();
    });

    it('should generate VarianceFields type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['AccountVarianceFields']).toBeDefined();
    });

    it('should generate VarPopFields type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['AccountVarPopFields']).toBeDefined();
    });

    it('should generate VarSampFields type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['AccountVarSampFields']).toBeDefined();
    });

    it('should include statistical fields in AggregateFields type', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['AccountAggregateFields'] as GraphQLObjectType | undefined;
      expect(aggType).toBeDefined();
      const fields = aggType!.getFields();
      expect(fields['stddev']).toBeDefined();
      expect(fields['stddevPop']).toBeDefined();
      expect(fields['stddevSamp']).toBeDefined();
      expect(fields['variance']).toBeDefined();
      expect(fields['varPop']).toBeDefined();
      expect(fields['varSamp']).toBeDefined();
    });
  });

  describe('Filter input types', () => {
    it('should generate BoolExp input type for client table', () => {
      const typeMap = schema.getTypeMap();
      const filterTypeNames = Object.keys(typeMap).filter((n) =>
        n.includes('BoolExp') && n.includes('Client'),
      );
      expect(filterTypeNames.length).toBeGreaterThan(0);
    });

    it('should generate JsonbCastExp type with String field', () => {
      const typeMap = schema.getTypeMap();
      const castType = typeMap['JsonbCastExp'] as GraphQLInputObjectType | undefined;
      expect(castType).toBeDefined();
      const fields = castType!.getFields();
      expect(fields['String']).toBeDefined();
      // The String field should reference StringComparisonExp
      const stringFieldType = fields['String'].type;
      expect((stringFieldType as GraphQLInputObjectType).name).toBe('StringComparisonExp');
    });

    it('should include _cast field in JsonbComparisonExp', () => {
      const typeMap = schema.getTypeMap();
      const jsonCompType = typeMap['JsonbComparisonExp'] as GraphQLInputObjectType | undefined;
      expect(jsonCompType).toBeDefined();
      const fields = jsonCompType!.getFields();
      expect(fields['_cast']).toBeDefined();
      const castFieldType = fields['_cast'].type;
      expect((castFieldType as GraphQLInputObjectType).name).toBe('JsonbCastExp');
    });
  });

  describe('Aggregate BoolExp types', () => {
    it('should generate AggregateBoolExp type for tables that are array relationship targets', () => {
      const typeMap = schema.getTypeMap();
      // Account is a target of client.accounts array relationship
      expect(typeMap['AccountAggregateBoolExp']).toBeDefined();
    });

    it('should generate lowercase-start AggregateBoolExpCount type', () => {
      const typeMap = schema.getTypeMap();
      // Must use lowercase-start naming per Hasura convention
      expect(typeMap['accountAggregateBoolExpCount']).toBeDefined();
    });

    it('should have count field on AggregateBoolExp', () => {
      const typeMap = schema.getTypeMap();
      const aggType = typeMap['AccountAggregateBoolExp'] as GraphQLInputObjectType | undefined;
      expect(aggType).toBeDefined();
      const fields = aggType!.getFields();
      expect(fields['count']).toBeDefined();
    });

    it('should have predicate as non-null IntComparisonExp on count type', () => {
      const typeMap = schema.getTypeMap();
      const countType = typeMap['accountAggregateBoolExpCount'] as GraphQLInputObjectType | undefined;
      expect(countType).toBeDefined();
      const fields = countType!.getFields();
      expect(fields['predicate']).toBeDefined();
      expect(fields['predicate'].type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have filter, distinct, and arguments fields on count type', () => {
      const typeMap = schema.getTypeMap();
      const countType = typeMap['accountAggregateBoolExpCount'] as GraphQLInputObjectType | undefined;
      expect(countType).toBeDefined();
      const fields = countType!.getFields();
      expect(fields['filter']).toBeDefined();
      expect(fields['distinct']).toBeDefined();
      expect(fields['arguments']).toBeDefined();
    });

    it('should have aggregate filter field on parent BoolExp for array relationships', () => {
      const typeMap = schema.getTypeMap();
      const clientBoolExp = typeMap['ClientBoolExp'] as GraphQLInputObjectType | undefined;
      expect(clientBoolExp).toBeDefined();
      const fields = clientBoolExp!.getFields();
      // Client has array relationship 'accounts' -> should have 'accountsAggregate'
      expect(fields['accountsAggregate']).toBeDefined();
    });
  });

  describe('JSONB path argument', () => {
    it('should add path: String argument to JSONB column fields', () => {
      const clientDataType = schema.getType('ClientData') as GraphQLObjectType;
      expect(clientDataType).toBeDefined();
      const valueField = clientDataType.getFields()['value'];
      expect(valueField).toBeDefined();
      const argNames = valueField.args.map((a) => a.name);
      expect(argNames).toContain('path');
      const pathArg = valueField.args.find((a) => a.name === 'path')!;
      expect(pathArg.type.toString()).toBe('String');
    });

    it('should add path: String argument to other JSONB columns (e.g., client.metadata)', () => {
      const clientType = schema.getType('Client') as GraphQLObjectType;
      expect(clientType).toBeDefined();
      const metadataField = clientType.getFields()['metadata'];
      expect(metadataField).toBeDefined();
      const argNames = metadataField.args.map((a) => a.name);
      expect(argNames).toContain('path');
    });

    it('should not add path argument to non-JSONB columns', () => {
      const clientType = schema.getType('Client') as GraphQLObjectType;
      expect(clientType).toBeDefined();
      const usernameField = clientType.getFields()['username'];
      expect(usernameField).toBeDefined();
      expect(usernameField.args).toHaveLength(0);
    });
  });
});
