import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema, GraphQLObjectType, GraphQLInputObjectType, GraphQLNonNull, GraphQLList } from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { resetCustomOutputTypeCache } from '../src/schema/custom-queries.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import type { SchemaModel } from '../src/types.js';
import { getPool, closePool, waitForDb, METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL } from './setup.js';

let schemaModel: SchemaModel;
let schema: GraphQLSchema;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  resetCustomOutputTypeCache();
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

  describe('Custom queries', () => {
    it('should register custom query fields in the Query type', () => {
      const queryType = schema.getQueryType()!;
      const fields = queryType.getFields();
      expect(fields['getClientWithBalance']).toBeDefined();
      expect(fields['getTopClients']).toBeDefined();
    });

    it('should register custom mutation fields in the Mutation type', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      expect(fields['creditAccount']).toBeDefined();
    });

    it('should generate ClientWithBalance output type with correct fields', () => {
      const typeMap = schema.getTypeMap();
      const cwbType = typeMap['ClientWithBalance'] as GraphQLObjectType | undefined;
      expect(cwbType).toBeDefined();
      const fields = cwbType!.getFields();
      expect(fields['id']).toBeDefined();
      expect(fields['username']).toBeDefined();
      expect(fields['email']).toBeDefined();
      expect(fields['status']).toBeDefined();
      expect(fields['totalBalance']).toBeDefined();
      expect(fields['totalCredit']).toBeDefined();
    });

    it('should generate TopClient output type with correct fields', () => {
      const typeMap = schema.getTypeMap();
      const tcType = typeMap['TopClient'] as GraphQLObjectType | undefined;
      expect(tcType).toBeDefined();
      const fields = tcType!.getFields();
      expect(fields['id']).toBeDefined();
      expect(fields['username']).toBeDefined();
      expect(fields['totalBalance']).toBeDefined();
      expect(fields['totalPayments']).toBeDefined();
      expect(fields['paymentCount']).toBeDefined();
      expect(fields['totalAppointments']).toBeDefined();
    });

    it('should generate AccountBalance output type with correct fields', () => {
      const typeMap = schema.getTypeMap();
      const abType = typeMap['AccountBalance'] as GraphQLObjectType | undefined;
      expect(abType).toBeDefined();
      const fields = abType!.getFields();
      expect(fields['id']).toBeDefined();
      expect(fields['clientId']).toBeDefined();
      expect(fields['balance']).toBeDefined();
      expect(fields['creditBalance']).toBeDefined();
    });

    it('should have correct args on getClientWithBalance query', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['getClientWithBalance'];
      expect(field).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      expect(argNames).toContain('clientId');
      expect(argNames).toHaveLength(1);
      const clientIdArg = field.args.find((a) => a.name === 'clientId')!;
      expect(clientIdArg.type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have correct args on getTopClients query', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['getTopClients'];
      expect(field).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      expect(argNames).toContain('branchId');
      expect(argNames).toContain('limit');
      expect(argNames).toHaveLength(2);
    });

    it('should have correct args on creditAccount mutation', () => {
      const mutationType = schema.getMutationType()!;
      const field = mutationType.getFields()['creditAccount'];
      expect(field).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      expect(argNames).toContain('accountId');
      expect(argNames).toContain('amount');
      expect(argNames).toHaveLength(2);
    });

    it('should return list type for custom queries', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['getClientWithBalance'];
      expect(field.type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should return nullable type for custom mutations', () => {
      const mutationType = schema.getMutationType()!;
      const field = mutationType.getFields()['creditAccount'];
      expect(field.type).not.toBeInstanceOf(GraphQLNonNull);
    });
  });
});
