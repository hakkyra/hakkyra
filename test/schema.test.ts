import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GraphQLSchema, GraphQLObjectType, GraphQLInputObjectType, GraphQLEnumType, GraphQLNonNull, GraphQLList, GraphQLScalarType } from 'graphql';
import { generateSchema } from '../src/schema/generator.js';
import { introspectDatabase } from '../src/introspection/introspector.js';
import { mergeSchemaModel, resolveTableEnums } from '../src/introspection/merger.js';
import { loadConfig } from '../src/config/loader.js';
import { getTypeName } from '../src/schema/type-builder.js';
import type { SchemaModel, TableInfo, HakkyraConfig } from '../src/types.js';
import { resetComparisonTypeCache } from '../src/schema/filters.js';
import { getPool, closePool, waitForDb, METADATA_DIR, SERVER_CONFIG_PATH, TEST_DB_URL } from './setup.js';

let schemaModel: SchemaModel;
let schema: GraphQLSchema;
let config: HakkyraConfig;
/** Schema generated with actions (for async action subscription tests). */
let schemaWithActions: GraphQLSchema;

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  await waitForDb();
  const pool = getPool();
  const introspection = await introspectDatabase(pool);
  config = await loadConfig(METADATA_DIR, SERVER_CONFIG_PATH);
  const result = mergeSchemaModel(introspection, config);
  schemaModel = result.model;
  await resolveTableEnums(schemaModel, pool);
  schema = generateSchema(schemaModel, {
    actions: config.actions,
    actionsGraphql: config.actionsGraphql,
  });

  // Build a second schema with action fields enabled for subscription tests.
  resetComparisonTypeCache();
  schemaWithActions = generateSchema(schemaModel, {
    actions: config.actions,
    actionsGraphql: config.actionsGraphql,
  });
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

    it('should have updateMany field with array return type [MutationResponse]', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      const updateManyField = fields['updateClientMany'];
      expect(updateManyField).toBeDefined();
      // Hasura returns [MutationResponse] (one result per update entry)
      const returnType = updateManyField.type;
      expect(returnType).toBeInstanceOf(GraphQLList);
      const innerType = (returnType as GraphQLList<any>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLObjectType);
      expect(innerType.name).toBe('ClientMutationResponse');
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

    it('should have aggregate subscription fields', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      expect(fields['clientsAggregate']).toBeDefined();
    });

    it('should have stream subscription fields', () => {
      const subscriptionType = schema.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      // Stream field uses base name (toCamelCase(table.name) + "Stream"), not custom select name
      expect(fields['clientStream']).toBeDefined();
    });
  });

  describe('subscription_root with actions', () => {
    it('should have async action result subscription field (P10.6)', () => {
      const subscriptionType = schemaWithActions.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      // requestVerification is the async action in test fixtures
      expect(fields['requestVerification']).toBeDefined();
    });

    it('should have id arg on async action result subscription field', () => {
      const subscriptionType = schemaWithActions.getSubscriptionType()!;
      const field = subscriptionType.getFields()['requestVerification'];
      expect(field).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      expect(argNames).toContain('id');
    });

    it('should not have sync action fields as subscription fields', () => {
      const subscriptionType = schemaWithActions.getSubscriptionType()!;
      const fields = subscriptionType.getFields();
      // createPayment is a sync mutation — should NOT appear in subscriptions
      expect(fields['createPayment']).toBeUndefined();
      // checkDiscountEligibility is a sync query — should NOT appear in subscriptions
      expect(fields['checkDiscountEligibility']).toBeUndefined();
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

    it('should have array relationships as nullable list of non-null items [Type!] (P10.7)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const accountsField = clientType.getFields()['accounts'];
      // Hasura returns nullable arrays: [Type!], NOT [Type!]!
      expect(accountsField.type).toBeInstanceOf(GraphQLList);
      expect(accountsField.type).not.toBeInstanceOf(GraphQLNonNull);
      // Inner items should be non-null
      const innerType = (accountsField.type as GraphQLList<any>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have all array relationships as nullable [Type!] not [Type!]! (P10.7)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      // Check multiple array relationships on Client
      for (const relName of ['accounts', 'invoices', 'ledgerEntries']) {
        const field = fields[relName];
        expect(field).toBeDefined();
        // Should be [Type!] — nullable list of non-null items
        expect(field.type).toBeInstanceOf(GraphQLList);
        expect(field.type).not.toBeInstanceOf(GraphQLNonNull);
        expect(field.type.toString()).toMatch(/^\[.+!\]$/); // [Type!] not [Type!]!
      }
    });

    it('should have non-null object relationships when FK column is NOT NULL (P9.7c)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      // branch_id is NOT NULL → branch relationship should be non-null
      expect(fields['branch'].type).toBeInstanceOf(GraphQLNonNull);
      // currency_id is NOT NULL → currency relationship should be non-null
      expect(fields['currency'].type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have nullable object relationships when FK column is nullable (P9.7c)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      // country_id is nullable → country relationship should be nullable
      expect(fields['country'].type).not.toBeInstanceOf(GraphQLNonNull);
      // language_id is nullable → language relationship should be nullable
      expect(fields['language'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have non-null object relationship for composite FK with all NOT NULL columns (P9.7c)', () => {
      const typeMap = schema.getTypeMap();
      const fiscalReportType = typeMap['FiscalReport'] as GraphQLObjectType | undefined;
      expect(fiscalReportType).toBeDefined();
      const fields = fiscalReportType!.getFields();
      // fiscal_year and fiscal_quarter are both NOT NULL → fiscalPeriod should be non-null
      expect(fields['fiscalPeriod']).toBeDefined();
      expect(fields['fiscalPeriod'].type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have nullable object relationship for manual config without FK localColumns (P9.7c)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      // primaryAccount uses manual_configuration mapping id → client_id
      // No FK constraint from client → account, so it should remain nullable
      expect(fields['primaryAccount']).toBeDefined();
      expect(fields['primaryAccount'].type).not.toBeInstanceOf(GraphQLNonNull);
    });
  });

  describe('Aggregate relationship fields on object types', () => {
    it('should have {rel}Aggregate fields for each array relationship', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      // Client has array relationships: accounts, invoices, ledgerEntries, etc.
      expect(fields['accountsAggregate']).toBeDefined();
      expect(fields['invoicesAggregate']).toBeDefined();
      expect(fields['ledgerEntriesAggregate']).toBeDefined();
    });

    it('should return the correct aggregate type for the related table', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const invoicesAggField = clientType.getFields()['invoicesAggregate'];
      // Should be NonNull(InvoiceAggregate)
      expect(invoicesAggField.type).toBeInstanceOf(GraphQLNonNull);
      const innerType = (invoicesAggField.type as GraphQLNonNull<any>).ofType;
      expect(innerType.name).toBe('InvoiceAggregate');
    });

    it('should have where argument on aggregate relationship fields', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const invoicesAggField = clientType.getFields()['invoicesAggregate'];
      const argNames = invoicesAggField.args.map((a) => a.name);
      expect(argNames).toContain('where');
    });

    it('should not have aggregate fields for object relationships', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      // branch is an object relationship — no branchAggregate should exist
      expect(fields['branchAggregate']).toBeUndefined();
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

    it('should register Timestamp scalar type (P10.12)', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['Timestamp']).toBeDefined();
    });

    it('should register Smallint scalar type (P10.13)', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['Smallint']).toBeDefined();
    });

    it('should register json scalar type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['json']).toBeDefined();
    });

    it('should register Numeric scalar type', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['Numeric']).toBeDefined();
    });

    it('should generate TimestampComparisonExp for Timestamp scalar (P10.12)', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['TimestampComparisonExp'] as GraphQLInputObjectType | undefined;
      expect(compType).toBeDefined();
      const fields = compType!.getFields();
      expect(fields['_eq']).toBeDefined();
      expect(fields['_gt']).toBeDefined();
      expect(fields['_lt']).toBeDefined();
      expect(fields['_gte']).toBeDefined();
      expect(fields['_lte']).toBeDefined();
    });

    it('should generate SmallintComparisonExp for Smallint scalar (P10.13)', () => {
      const typeMap = schema.getTypeMap();
      const compType = typeMap['SmallintComparisonExp'] as GraphQLInputObjectType | undefined;
      expect(compType).toBeDefined();
      const fields = compType!.getFields();
      expect(fields['_eq']).toBeDefined();
      expect(fields['_gt']).toBeDefined();
      expect(fields['_lt']).toBeDefined();
      expect(fields['_gte']).toBeDefined();
      expect(fields['_lte']).toBeDefined();
    });

    it('should use Timestamp scalar for timestamp-without-tz columns (P10.12)', () => {
      const typeMap = schema.getTypeMap();
      const transactionType = typeMap['Transaction'] as GraphQLObjectType | undefined;
      expect(transactionType).toBeDefined();
      const fields = transactionType!.getFields();
      // local_time is TIMESTAMP WITHOUT TIME ZONE -> Timestamp scalar
      expect(fields['localTime']).toBeDefined();
      const localTimeType = fields['localTime'].type.toString();
      expect(localTimeType).toBe('Timestamp');
      // created_at is TIMESTAMPTZ -> Timestamptz scalar (should remain unchanged)
      expect(fields['createdAt']).toBeDefined();
      const createdAtType = fields['createdAt'].type.toString();
      expect(createdAtType).toBe('Timestamptz');
    });

    it('should use Smallint scalar for smallint columns (P10.13)', () => {
      const typeMap = schema.getTypeMap();
      const transactionType = typeMap['Transaction'] as GraphQLObjectType | undefined;
      expect(transactionType).toBeDefined();
      const fields = transactionType!.getFields();
      // sequence is SMALLINT -> Smallint scalar
      expect(fields['sequence']).toBeDefined();
      const sequenceType = fields['sequence'].type.toString();
      expect(sequenceType).toBe('Smallint!');
    });
  });

  describe('Enum types', () => {
    it('should generate GraphQL enum types from PG enums', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['ClientStatus']).toBeDefined();
      expect(typeMap['InvoiceState']).toBeDefined();
      expect(typeMap['LedgerType']).toBeDefined();
    });

    it('should expose columns with FK to is_enum tables as enum scalar fields (P9.14)', () => {
      const typeMap = schema.getTypeMap();
      const appointmentType = typeMap['Appointment'] as GraphQLObjectType;
      expect(appointmentType).toBeDefined();
      const fields = appointmentType.getFields();
      // priority column has FK to priority_type (is_enum: true)
      // Should be exposed as PriorityTypeEnum scalar, not filtered out
      expect(fields['priority']).toBeDefined();
      expect(fields['priority'].type.toString()).toBe('PriorityTypeEnum!');
    });

    it('should remove object relationships pointing to is_enum tables', () => {
      const typeMap = schema.getTypeMap();
      const appointmentType = typeMap['Appointment'] as GraphQLObjectType;
      expect(appointmentType).toBeDefined();
      const fields = appointmentType.getFields();
      // No object relationship to priority_type should exist
      // (the FK is handled as an enum scalar, not a relationship)
      expect(fields['priorityType']).toBeUndefined();
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

  describe('Aggregate return types — array fields in min/max (P10.10)', () => {
    it('should return [String!] for text[] columns in MinFields', () => {
      const typeMap = schema.getTypeMap();
      const minType = typeMap['SupplierMinFields'] as GraphQLObjectType | undefined;
      expect(minType).toBeDefined();
      const fields = minType!.getFields();
      // supplier.tags is text[] → should be [String!], not String
      expect(fields['tags']).toBeDefined();
      expect(fields['tags'].type.toString()).toBe('[String!]');
    });

    it('should return [Int!] for int[] columns in MinFields', () => {
      const typeMap = schema.getTypeMap();
      const minType = typeMap['SupplierMinFields'] as GraphQLObjectType | undefined;
      expect(minType).toBeDefined();
      const fields = minType!.getFields();
      // supplier.ratings is int[] → should be [Int!], not Int
      expect(fields['ratings']).toBeDefined();
      expect(fields['ratings'].type.toString()).toBe('[Int!]');
    });

    it('should return [String!] for text[] columns in MaxFields', () => {
      const typeMap = schema.getTypeMap();
      const maxType = typeMap['SupplierMaxFields'] as GraphQLObjectType | undefined;
      expect(maxType).toBeDefined();
      const fields = maxType!.getFields();
      expect(fields['tags']).toBeDefined();
      expect(fields['tags'].type.toString()).toBe('[String!]');
    });

    it('should return [Int!] for int[] columns in MaxFields', () => {
      const typeMap = schema.getTypeMap();
      const maxType = typeMap['SupplierMaxFields'] as GraphQLObjectType | undefined;
      expect(maxType).toBeDefined();
      const fields = maxType!.getFields();
      expect(fields['ratings']).toBeDefined();
      expect(fields['ratings'].type.toString()).toBe('[Int!]');
    });

    it('should still return scalar types for non-array columns in MinFields', () => {
      const typeMap = schema.getTypeMap();
      const minType = typeMap['SupplierMinFields'] as GraphQLObjectType | undefined;
      expect(minType).toBeDefined();
      const fields = minType!.getFields();
      // supplier.name is text (non-array) → should be String
      expect(fields['name']).toBeDefined();
      expect(fields['name'].type.toString()).toBe('String');
    });
  });

  describe('Aggregate return types — stat return types (P10.11)', () => {
    it('should return Numeric for numeric source columns in AvgFields', () => {
      const typeMap = schema.getTypeMap();
      const avgType = typeMap['AccountAvgFields'] as GraphQLObjectType | undefined;
      expect(avgType).toBeDefined();
      const fields = avgType!.getFields();
      // account.balance is NUMERIC → avg should return Numeric, not Float
      expect(fields['balance']).toBeDefined();
      expect(fields['balance'].type.toString()).toBe('Numeric');
    });

    it('should return Float for integer source columns in AvgFields', () => {
      const typeMap = schema.getTypeMap();
      const avgType = typeMap['ClientAvgFields'] as GraphQLObjectType | undefined;
      expect(avgType).toBeDefined();
      const fields = avgType!.getFields();
      // client.trust_level is INT → avg should return Float
      expect(fields['trustLevel']).toBeDefined();
      expect(fields['trustLevel'].type.toString()).toBe('Float');
    });

    it('should return Numeric for numeric source columns in StddevFields', () => {
      const typeMap = schema.getTypeMap();
      const stddevType = typeMap['AccountStddevFields'] as GraphQLObjectType | undefined;
      expect(stddevType).toBeDefined();
      const fields = stddevType!.getFields();
      expect(fields['balance']).toBeDefined();
      expect(fields['balance'].type.toString()).toBe('Numeric');
    });

    it('should return Float for integer source columns in StddevFields', () => {
      const typeMap = schema.getTypeMap();
      const stddevType = typeMap['ClientStddevFields'] as GraphQLObjectType | undefined;
      expect(stddevType).toBeDefined();
      const fields = stddevType!.getFields();
      expect(fields['trustLevel']).toBeDefined();
      expect(fields['trustLevel'].type.toString()).toBe('Float');
    });

    it('should return Numeric for numeric source columns in VarianceFields', () => {
      const typeMap = schema.getTypeMap();
      const varType = typeMap['AccountVarianceFields'] as GraphQLObjectType | undefined;
      expect(varType).toBeDefined();
      const fields = varType!.getFields();
      expect(fields['balance']).toBeDefined();
      expect(fields['balance'].type.toString()).toBe('Numeric');
    });

    it('should return Numeric for numeric source columns in VarPopFields', () => {
      const typeMap = schema.getTypeMap();
      const varPopType = typeMap['AccountVarPopFields'] as GraphQLObjectType | undefined;
      expect(varPopType).toBeDefined();
      const fields = varPopType!.getFields();
      expect(fields['balance']).toBeDefined();
      expect(fields['balance'].type.toString()).toBe('Numeric');
    });

    it('should return Numeric for numeric source columns in StddevPopFields', () => {
      const typeMap = schema.getTypeMap();
      const stddevPopType = typeMap['AccountStddevPopFields'] as GraphQLObjectType | undefined;
      expect(stddevPopType).toBeDefined();
      const fields = stddevPopType!.getFields();
      expect(fields['balance']).toBeDefined();
      expect(fields['balance'].type.toString()).toBe('Numeric');
    });

    it('should return Numeric for numeric source columns in StddevSampFields', () => {
      const typeMap = schema.getTypeMap();
      const stddevSampType = typeMap['AccountStddevSampFields'] as GraphQLObjectType | undefined;
      expect(stddevSampType).toBeDefined();
      const fields = stddevSampType!.getFields();
      expect(fields['balance']).toBeDefined();
      expect(fields['balance'].type.toString()).toBe('Numeric');
    });

    it('should return Int for integer source columns in SumFields', () => {
      const typeMap = schema.getTypeMap();
      const sumType = typeMap['ClientSumFields'] as GraphQLObjectType | undefined;
      expect(sumType).toBeDefined();
      const fields = sumType!.getFields();
      // client.trust_level is INT → sum should return Int
      expect(fields['trustLevel']).toBeDefined();
      expect(fields['trustLevel'].type.toString()).toBe('Int');
    });

    it('should return Numeric for numeric source columns in SumFields', () => {
      const typeMap = schema.getTypeMap();
      const sumType = typeMap['AccountSumFields'] as GraphQLObjectType | undefined;
      expect(sumType).toBeDefined();
      const fields = sumType!.getFields();
      // account.balance is NUMERIC → sum should return Numeric
      expect(fields['balance']).toBeDefined();
      expect(fields['balance'].type.toString()).toBe('Numeric');
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

  describe('Table-level custom_name type naming (P9.5)', () => {
    // Unit tests for getTypeName
    it('getTypeName should return alias verbatim when set', () => {
      const table = { alias: 'gameSession' } as TableInfo;
      expect(getTypeName(table)).toBe('gameSession');
    });

    it('getTypeName should NOT PascalCase the alias', () => {
      const table = { alias: 'gameSession' } as TableInfo;
      // Must not become "GameSession"
      expect(getTypeName(table)).not.toBe('GameSession');
    });

    it('getTypeName should PascalCase the table name when no alias is set', () => {
      const table = { name: 'game_session' } as TableInfo;
      expect(getTypeName(table)).toBe('GameSession');
    });

    // Integration test: fiscal_period has custom_name: fiscalPeriod in metadata
    it('should use custom_name verbatim as the GraphQL type name (fiscalPeriod, not FiscalPeriod)', () => {
      const typeMap = schema.getTypeMap();
      // With custom_name: fiscalPeriod, the type should be "fiscalPeriod" (verbatim)
      expect(typeMap['fiscalPeriod']).toBeDefined();
      // The old PascalCased name should NOT exist
      expect(typeMap['FiscalPeriod']).toBeUndefined();
    });

    it('should use custom_name verbatim for derived input type names', () => {
      const typeMap = schema.getTypeMap();
      // BoolExp, OrderBy, InsertInput, etc. should all use the verbatim custom_name
      expect(typeMap['fiscalPeriodBoolExp']).toBeDefined();
      expect(typeMap['fiscalPeriodOrderBy']).toBeDefined();
      expect(typeMap['fiscalPeriodInsertInput']).toBeDefined();
      expect(typeMap['fiscalPeriodSetInput']).toBeDefined();
      expect(typeMap['fiscalPeriodSelectColumn']).toBeDefined();
    });

    it('should use custom_name verbatim for aggregate type names', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['fiscalPeriodAggregate']).toBeDefined();
      expect(typeMap['fiscalPeriodAggregateFields']).toBeDefined();
    });

    it('should use custom_name verbatim for mutation response type names', () => {
      const typeMap = schema.getTypeMap();
      expect(typeMap['fiscalPeriodMutationResponse']).toBeDefined();
    });

    it('tables without custom_name should still use PascalCase', () => {
      const typeMap = schema.getTypeMap();
      // "client" table has no custom_name, so type should be PascalCase "Client"
      expect(typeMap['Client']).toBeDefined();
      // "account" table has no custom_name, so type should be PascalCase "Account"
      expect(typeMap['Account']).toBeDefined();
    });
  });

  describe('Constraint enum types (P10.5)', () => {
    it('should populate constraint enum with real PK constraint name', () => {
      const typeMap = schema.getTypeMap();
      const constraintEnum = typeMap['AccountConstraint'] as GraphQLEnumType | undefined;
      expect(constraintEnum).toBeDefined();
      const values = constraintEnum!.getValues();
      // Should have at least the PK constraint
      expect(values.length).toBeGreaterThanOrEqual(1);
      // PK constraint should be camelCased from the real PG constraint name
      const pkValue = values.find((v) => v.name.includes('Pkey'));
      expect(pkValue).toBeDefined();
      // Internal value should be the raw PG constraint name (contains underscores)
      expect(pkValue!.value).toContain('pkey');
      expect(pkValue!.value).toContain('_');
    });

    it('should camelCase constraint enum value names', () => {
      const typeMap = schema.getTypeMap();
      const constraintEnum = typeMap['CurrencyConstraint'] as GraphQLEnumType | undefined;
      expect(constraintEnum).toBeDefined();
      const values = constraintEnum!.getValues();
      for (const v of values) {
        // Enum keys should be camelCase (no underscores)
        expect(v.name).not.toContain('_');
        // Internal values should be the raw PG constraint names
        expect(typeof v.value).toBe('string');
      }
    });

    it('should include both PK and unique constraints in the enum', () => {
      const typeMap = schema.getTypeMap();
      const constraintEnum = typeMap['ClientDataConstraint'] as GraphQLEnumType | undefined;
      expect(constraintEnum).toBeDefined();
      const values = constraintEnum!.getValues();
      // client_data has PK + unique(client_id, key) constraint
      expect(values.length).toBeGreaterThanOrEqual(2);
      // One should be the PK
      expect(values.some((v) => v.name.includes('Pkey'))).toBe(true);
    });

    it('should not generate empty constraint enums', () => {
      const typeMap = schema.getTypeMap();
      // All Constraint types in the schema should have at least one value
      for (const [name, type] of Object.entries(typeMap)) {
        if (name.endsWith('Constraint') && type instanceof GraphQLEnumType) {
          const values = type.getValues();
          expect(values.length).toBeGreaterThan(0);
        }
      }
    });

    it('should use real introspected constraint names, not fabricated ones', () => {
      // Verify the PK constraint name comes from the actual DB, not a convention guess
      const table = schemaModel.tables.find((t) => t.name === 'client');
      expect(table).toBeDefined();
      expect(table!.primaryKeyConstraintName).toBeDefined();
      expect(typeof table!.primaryKeyConstraintName).toBe('string');
      expect(table!.primaryKeyConstraintName!.length).toBeGreaterThan(0);
    });
  });

  describe('Action argument scalar type parity (P10.3)', () => {
    it('should use Bigint scalar for ContentEventInput.playerId', () => {
      const typeMap = schema.getTypeMap();
      const inputType = typeMap['ContentEventInput'] as GraphQLInputObjectType;
      expect(inputType).toBeDefined();
      const fields = inputType.getFields();
      expect(fields['playerId']).toBeDefined();
      // Should be NonNull(Bigint), not NonNull(String)
      expect(fields['playerId'].type.toString()).toBe('Bigint!');
    });

    it('should use Jsonb scalar for ContentEventInput.parameters', () => {
      const typeMap = schema.getTypeMap();
      const inputType = typeMap['ContentEventInput'] as GraphQLInputObjectType;
      const fields = inputType.getFields();
      expect(fields['parameters']).toBeDefined();
      expect(fields['parameters'].type.toString()).toBe('Jsonb');
    });

    it('should use _text scalar for ContentEventInput.tags', () => {
      const typeMap = schema.getTypeMap();
      const inputType = typeMap['ContentEventInput'] as GraphQLInputObjectType;
      const fields = inputType.getFields();
      expect(fields['tags']).toBeDefined();
      expect(fields['tags'].type.toString()).toBe('_text');
    });

    it('should use SDL-defined ContentCategory enum for ContentEventInput.category', () => {
      const typeMap = schema.getTypeMap();
      const inputType = typeMap['ContentEventInput'] as GraphQLInputObjectType;
      const fields = inputType.getFields();
      expect(fields['category']).toBeDefined();
      expect(fields['category'].type.toString()).toBe('ContentCategory!');
      // Verify it's actually an enum type
      const enumType = typeMap['ContentCategory'];
      expect(enumType).toBeDefined();
      expect(enumType).toBeInstanceOf(GraphQLEnumType);
    });

    it('should use Timestamptz scalar for ContentEventInput.occurredAt', () => {
      const typeMap = schema.getTypeMap();
      const inputType = typeMap['ContentEventInput'] as GraphQLInputObjectType;
      const fields = inputType.getFields();
      expect(fields['occurredAt']).toBeDefined();
      expect(fields['occurredAt'].type.toString()).toBe('Timestamptz');
    });

    it('should use Numeric scalar for ContentEventInput.amount', () => {
      const typeMap = schema.getTypeMap();
      const inputType = typeMap['ContentEventInput'] as GraphQLInputObjectType;
      const fields = inputType.getFields();
      expect(fields['amount']).toBeDefined();
      expect(fields['amount'].type.toString()).toBe('Numeric');
    });

    it('should use Uuid scalar for ContentEventResult.eventId', () => {
      const typeMap = schema.getTypeMap();
      const outputType = typeMap['ContentEventResult'] as GraphQLObjectType;
      expect(outputType).toBeDefined();
      const fields = outputType.getFields();
      expect(fields['eventId']).toBeDefined();
      expect(fields['eventId'].type.toString()).toBe('Uuid!');
    });

    it('should use ContentCategory enum in output type', () => {
      const typeMap = schema.getTypeMap();
      const outputType = typeMap['ContentEventResult'] as GraphQLObjectType;
      const fields = outputType.getFields();
      expect(fields['category']).toBeDefined();
      expect(fields['category'].type.toString()).toBe('ContentCategory!');
    });

    it('should use _text scalar in output type', () => {
      const typeMap = schema.getTypeMap();
      const outputType = typeMap['ContentEventResult'] as GraphQLObjectType;
      const fields = outputType.getFields();
      expect(fields['processedTags']).toBeDefined();
      expect(fields['processedTags'].type.toString()).toBe('_text');
    });

    it('should use Jsonb scalar in output type', () => {
      const typeMap = schema.getTypeMap();
      const outputType = typeMap['ContentEventResult'] as GraphQLObjectType;
      const fields = outputType.getFields();
      expect(fields['metadata']).toBeDefined();
      expect(fields['metadata'].type.toString()).toBe('Jsonb');
    });
  });

  describe('Prefixed root field casing with custom_name (P10.15)', () => {
    // fiscal_period has custom_name: fiscalPeriod — prefixed root fields must
    // capitalize the first letter after the prefix: insertFiscalPeriod, not insertfiscalPeriod.

    it('should capitalize custom_name first letter in insert root field names', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      expect(fields['insertFiscalPeriod']).toBeDefined();
      expect(fields['insertFiscalPeriodOne']).toBeDefined();
      // Must NOT have lowercase-start variant
      expect(fields['insertfiscalPeriod']).toBeUndefined();
      expect(fields['insertfiscalPeriodOne']).toBeUndefined();
    });

    it('should capitalize custom_name first letter in update root field names', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      expect(fields['updateFiscalPeriod']).toBeDefined();
      expect(fields['updateFiscalPeriodByPk']).toBeDefined();
      expect(fields['updateFiscalPeriodMany']).toBeDefined();
      // Must NOT have lowercase-start variant
      expect(fields['updatefiscalPeriod']).toBeUndefined();
      expect(fields['updatefiscalPeriodByPk']).toBeUndefined();
      expect(fields['updatefiscalPeriodMany']).toBeUndefined();
    });

    it('should capitalize custom_name first letter in delete root field names', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      expect(fields['deleteFiscalPeriod']).toBeDefined();
      // Must NOT have lowercase-start variant
      expect(fields['deletefiscalPeriod']).toBeUndefined();
    });

    it('should keep PascalCase unchanged for tables without custom_name', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();
      // "client" has custom_root_fields overriding names (insertClients, etc.)
      // "account" has no custom_name → PascalCase "Account" → insertAccount (already correct)
      expect(fields['insertAccount']).toBeDefined();
      expect(fields['updateAccount']).toBeDefined();
      expect(fields['deleteAccount']).toBeDefined();
    });
  });

  describe('Scalar-returning tracked functions (P10.17)', () => {
    it('should expose playerDataReport as a query field returning Jsonb!', () => {
      const queryType = schema.getQueryType()!;
      const fields = queryType.getFields();
      expect(fields['playerDataReport']).toBeDefined();
      // Return type should be Jsonb! (NonNull<Jsonb>)
      const returnType = fields['playerDataReport'].type;
      expect(returnType).toBeInstanceOf(GraphQLNonNull);
      const innerType = (returnType as GraphQLNonNull<any>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLScalarType);
      expect(innerType.name).toBe('Jsonb');
    });

    it('should expose playerProfile as a query field returning json!', () => {
      const queryType = schema.getQueryType()!;
      const fields = queryType.getFields();
      expect(fields['playerProfile']).toBeDefined();
      // Return type should be json! (NonNull<json>)
      const returnType = fields['playerProfile'].type;
      expect(returnType).toBeInstanceOf(GraphQLNonNull);
      const innerType = (returnType as GraphQLNonNull<any>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLScalarType);
      expect(innerType.name).toBe('json');
    });

    it('should have args input type for scalar-returning functions', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['playerDataReport'];
      expect(field).toBeDefined();
      const argsArg = field.args.find((a) => a.name === 'args');
      expect(argsArg).toBeDefined();
      // The args input type should have a playerId field
      const argsType = argsArg!.type as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['playerId']).toBeDefined();
    });

    it('should NOT have where/orderBy/limit/offset args on scalar-returning functions', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['playerDataReport'];
      expect(field).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      expect(argNames).not.toContain('where');
      expect(argNames).not.toContain('orderBy');
      expect(argNames).not.toContain('limit');
      expect(argNames).not.toContain('offset');
      expect(argNames).not.toContain('distinctOn');
    });
  });
});
