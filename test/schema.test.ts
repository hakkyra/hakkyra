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

    it('should have nullable _set arg on all update mutations (P12.18)', () => {
      const mutationType = schema.getMutationType()!;
      const fields = mutationType.getFields();

      // update (bulk) — _set should be nullable
      const updateField = fields['updateClients'];
      const updateSetArg = updateField.args.find((a) => a.name === '_set');
      expect(updateSetArg).toBeDefined();
      expect(updateSetArg!.type).not.toBeInstanceOf(GraphQLNonNull);

      // updateByPk — _set should be nullable
      const updateByPkField = fields['updateClientByPk'];
      const updateByPkSetArg = updateByPkField.args.find((a) => a.name === '_set');
      expect(updateByPkSetArg).toBeDefined();
      expect(updateByPkSetArg!.type).not.toBeInstanceOf(GraphQLNonNull);

      // updateMany — _set inside the Updates type should be nullable
      const updateManyField = fields['updateClientMany'];
      const updatesArg = updateManyField.args.find((a) => a.name === 'updates');
      expect(updatesArg).toBeDefined();
      // Unwrap NonNull > List > NonNull to get the Updates type
      const listType = (updatesArg!.type as GraphQLNonNull<any>).ofType as GraphQLList<any>;
      const inputType = (listType.ofType as GraphQLNonNull<any>).ofType as GraphQLInputObjectType;
      const setField = inputType.getFields()['_set'];
      expect(setField).toBeDefined();
      expect(setField.type).not.toBeInstanceOf(GraphQLNonNull);
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

    it('should have array relationships as non-null list of non-null items [Type!]! (P11.2)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const accountsField = clientType.getFields()['accounts'];
      // Hasura returns non-null arrays: [Type!]!
      expect(accountsField.type).toBeInstanceOf(GraphQLNonNull);
      const listType = (accountsField.type as GraphQLNonNull<any>).ofType;
      expect(listType).toBeInstanceOf(GraphQLList);
      // Inner items should be non-null
      const innerType = (listType as GraphQLList<any>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have all array relationships as [Type!]! not [Type!] (P11.2)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const fields = clientType.getFields();
      // Check multiple array relationships on Client
      for (const relName of ['accounts', 'invoices', 'ledgerEntries']) {
        const field = fields[relName];
        expect(field).toBeDefined();
        // Should be [Type!]! — non-null list of non-null items
        expect(field.type).toBeInstanceOf(GraphQLNonNull);
        expect(field.type.toString()).toMatch(/^\[.+!\]!$/); // [Type!]! not [Type!]
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

    it('should have nullable object relationship for manual_configuration even with NOT NULL FK columns (P12.9)', () => {
      const typeMap = schema.getTypeMap();
      const fiscalReportType = typeMap['FiscalReport'] as GraphQLObjectType | undefined;
      expect(fiscalReportType).toBeDefined();
      const fields = fiscalReportType!.getFields();
      // fiscal_year and fiscal_quarter are both NOT NULL and have a real FK,
      // but the relationship is defined via manual_configuration in metadata.
      // Hasura treats manual_configuration relationships as always nullable.
      expect(fields['fiscalPeriod']).toBeDefined();
      expect(fields['fiscalPeriod'].type).not.toBeInstanceOf(GraphQLNonNull);
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

    it('should have nullable reverse-FK object relationship (P12.9)', () => {
      const typeMap = schema.getTypeMap();
      const playerType = typeMap['Player'] as GraphQLObjectType;
      expect(playerType).toBeDefined();
      const fields = playerType.getFields();
      expect(fields['lock']).toBeDefined();
      expect(fields['lock'].type).not.toBeInstanceOf(GraphQLNonNull);
    });

    it('should have non-null forward-FK object relationship even when sibling reverse-FK exists (P12.9)', () => {
      const typeMap = schema.getTypeMap();
      const playerLockType = typeMap['PlayerLock'] as GraphQLObjectType;
      expect(playerLockType).toBeDefined();
      const fields = playerLockType.getFields();
      expect(fields['player']).toBeDefined();
      expect(fields['player'].type).toBeInstanceOf(GraphQLNonNull);
    });

    it('should have nullable manual_configuration on views (P12.9)', () => {
      const typeMap = schema.getTypeMap();
      const clientSummaryType = typeMap['ClientSummary'] as GraphQLObjectType;
      expect(clientSummaryType).toBeDefined();
      const fields = clientSummaryType.getFields();
      expect(fields['client']).toBeDefined();
      expect(fields['client'].type).not.toBeInstanceOf(GraphQLNonNull);
      expect(fields['branch']).toBeDefined();
      expect(fields['branch'].type).not.toBeInstanceOf(GraphQLNonNull);
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

    it('should have distinctOn, limit, offset, orderBy args on aggregate relationship fields (P11.5)', () => {
      const typeMap = schema.getTypeMap();
      const clientType = typeMap['Client'] as GraphQLObjectType;
      const invoicesAggField = clientType.getFields()['invoicesAggregate'];
      const argNames = invoicesAggField.args.map((a) => a.name);
      expect(argNames).toContain('distinctOn');
      expect(argNames).toContain('limit');
      expect(argNames).toContain('offset');
      expect(argNames).toContain('orderBy');
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
      // account.balance is NUMERIC → avg returns Numeric (Hasura behavior)
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

  describe('P12.13 — Exclude boolean columns from MaxOrderBy/MinOrderBy', () => {
    it('should not include boolean columns in MaxOrderBy', () => {
      const typeMap = schema.getTypeMap();
      const maxOrderBy = typeMap['AccountMaxOrderBy'] as GraphQLInputObjectType | undefined;
      expect(maxOrderBy).toBeDefined();
      const fields = maxOrderBy!.getFields();
      // account.active is BOOLEAN — should be excluded from MaxOrderBy
      expect(fields['active']).toBeUndefined();
      // account.balance is NUMERIC — should be included
      expect(fields['balance']).toBeDefined();
    });

    it('should not include boolean columns in MinOrderBy', () => {
      const typeMap = schema.getTypeMap();
      const minOrderBy = typeMap['AccountMinOrderBy'] as GraphQLInputObjectType | undefined;
      expect(minOrderBy).toBeDefined();
      const fields = minOrderBy!.getFields();
      // account.active is BOOLEAN — should be excluded from MinOrderBy
      expect(fields['active']).toBeUndefined();
      // account.balance is NUMERIC — should be included
      expect(fields['balance']).toBeDefined();
    });

    it('should still include boolean columns in the table OrderBy type', () => {
      const typeMap = schema.getTypeMap();
      const orderBy = typeMap['AccountOrderBy'] as GraphQLInputObjectType | undefined;
      expect(orderBy).toBeDefined();
      const fields = orderBy!.getFields();
      // Boolean columns are still orderable in the main OrderBy type
      expect(fields['active']).toBeDefined();
    });
  });

  describe('P12.20 — Include enum and UUID columns in MaxFields/MinFields', () => {
    it('should include UUID columns in MinFields', () => {
      const typeMap = schema.getTypeMap();
      const minType = typeMap['ClientMinFields'] as GraphQLObjectType | undefined;
      expect(minType).toBeDefined();
      const fields = minType!.getFields();
      // client.id is UUID — should be included in MinFields
      expect(fields['id']).toBeDefined();
      expect(fields['id'].type.toString()).toBe('Uuid');
    });

    it('should include UUID columns in MaxFields', () => {
      const typeMap = schema.getTypeMap();
      const maxType = typeMap['ClientMaxFields'] as GraphQLObjectType | undefined;
      expect(maxType).toBeDefined();
      const fields = maxType!.getFields();
      // client.id is UUID — should be included in MaxFields
      expect(fields['id']).toBeDefined();
      expect(fields['id'].type.toString()).toBe('Uuid');
    });

    it('should include enum-typed columns in MinFields', () => {
      const typeMap = schema.getTypeMap();
      const minType = typeMap['InvoiceMinFields'] as GraphQLObjectType | undefined;
      expect(minType).toBeDefined();
      const fields = minType!.getFields();
      // invoice.state is invoice_state enum — should be included in MinFields
      expect(fields['state']).toBeDefined();
      expect(fields['state'].type.toString()).toBe('InvoiceState');
      // invoice.type is ledger_type enum — should be included in MinFields
      expect(fields['type']).toBeDefined();
      expect(fields['type'].type.toString()).toBe('LedgerType');
    });

    it('should include enum-typed columns in MaxFields', () => {
      const typeMap = schema.getTypeMap();
      const maxType = typeMap['InvoiceMaxFields'] as GraphQLObjectType | undefined;
      expect(maxType).toBeDefined();
      const fields = maxType!.getFields();
      // invoice.state is invoice_state enum — should be included in MaxFields
      expect(fields['state']).toBeDefined();
      expect(fields['state'].type.toString()).toBe('InvoiceState');
      // invoice.type is ledger_type enum — should be included in MaxFields
      expect(fields['type']).toBeDefined();
      expect(fields['type'].type.toString()).toBe('LedgerType');
    });

    it('should still include numeric and string columns in MinFields/MaxFields', () => {
      const typeMap = schema.getTypeMap();
      const minType = typeMap['InvoiceMinFields'] as GraphQLObjectType | undefined;
      expect(minType).toBeDefined();
      const fields = minType!.getFields();
      // invoice.amount is NUMERIC — should still be included
      expect(fields['amount']).toBeDefined();
      // invoice.provider is TEXT — should still be included
      expect(fields['provider']).toBeDefined();
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

  describe('Computed field BoolExp filters (P11.11)', () => {
    it('should use relationship BoolExp for SETOF computed fields returning tracked tables', () => {
      const typeMap = schema.getTypeMap();
      const clientBoolExp = typeMap['ClientBoolExp'] as GraphQLInputObjectType | undefined;
      expect(clientBoolExp).toBeDefined();
      const fields = clientBoolExp!.getFields();
      // activeAccounts is a SETOF computed field returning 'account' (a tracked table)
      // It should use AccountBoolExp, not a scalar comparison type
      expect(fields['activeAccounts']).toBeDefined();
      const fieldType = fields['activeAccounts'].type as GraphQLInputObjectType;
      expect(fieldType.name).toBe('AccountBoolExp');
    });

    it('should not use scalar comparison for table-returning computed fields', () => {
      const typeMap = schema.getTypeMap();
      const clientBoolExp = typeMap['ClientBoolExp'] as GraphQLInputObjectType | undefined;
      expect(clientBoolExp).toBeDefined();
      const fields = clientBoolExp!.getFields();
      // activeAccounts should NOT be a scalar comparison like StringComparisonExp
      if (fields['activeAccounts']) {
        const fieldType = fields['activeAccounts'].type as GraphQLInputObjectType;
        expect(fieldType.name).not.toContain('ComparisonExp');
      }
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

  describe('Unique index constraint names in Constraint enums (P12.17)', () => {
    it('should not duplicate unique constraints that already have backing indexes', () => {
      const typeMap = schema.getTypeMap();
      const constraintEnum = typeMap['AccountConstraint'] as GraphQLEnumType | undefined;
      expect(constraintEnum).toBeDefined();
      const values = constraintEnum!.getValues();
      const nameSet = new Set(values.map((v) => v.value));
      expect(nameSet.size).toBe(values.length);
    });

    it('should not include non-unique indexes in Constraint enum', () => {
      const typeMap = schema.getTypeMap();
      const constraintEnum = typeMap['ClientConstraint'] as GraphQLEnumType | undefined;
      expect(constraintEnum).toBeDefined();
      const values = constraintEnum!.getValues();
      expect(values.every((v) => v.value !== 'idx_client_branch')).toBe(true);
      expect(values.every((v) => v.value !== 'idx_client_status')).toBe(true);
      expect(values.every((v) => v.value !== 'idx_client_email')).toBe(true);
    });

    it('should introspect unique index on materialized view (idx_client_summary_id)', () => {
      const table = schemaModel.tables.find((t) => t.name === 'client_summary');
      expect(table).toBeDefined();
      const uniqueIdx = table!.indexes.find((idx) => idx.name === 'idx_client_summary_id');
      expect(uniqueIdx).toBeDefined();
      expect(uniqueIdx!.isUnique).toBe(true);
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

    it('should have args input type for scalar-returning functions (non-null, P11.6)', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['playerDataReport'];
      expect(field).toBeDefined();
      const argsArg = field.args.find((a) => a.name === 'args');
      expect(argsArg).toBeDefined();
      // args should be NonNull (P11.6)
      expect(argsArg!.type).toBeInstanceOf(GraphQLNonNull);
      // The args input type should have a playerId field
      const argsType = (argsArg!.type as GraphQLNonNull<GraphQLInputObjectType>).ofType as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['player_id']).toBeDefined();
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

  describe('Tracked function arg scalar types (P11.4)', () => {
    it('should use Uuid scalar for uuid-typed function args', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['searchClientsAdvanced'];
      expect(field).toBeDefined();
      const argsArg = field.args.find((a) => a.name === 'args');
      expect(argsArg).toBeDefined();
      // args is NonNull (P11.6), unwrap to get the InputObjectType
      const argsType = (argsArg!.type as GraphQLNonNull<GraphQLInputObjectType>).ofType as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['p_id']).toBeDefined();
      expect(argsFields['p_id'].type.toString()).toBe('Uuid');
    });

    it('should use Numeric scalar for numeric-typed function args', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['searchClientsAdvanced'];
      const argsType = (field.args.find((a) => a.name === 'args')!.type as GraphQLNonNull<GraphQLInputObjectType>).ofType as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['p_min_balance']).toBeDefined();
      expect(argsFields['p_min_balance'].type.toString()).toBe('Numeric');
    });

    it('should use Jsonb scalar for jsonb-typed function args', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['searchClientsAdvanced'];
      const argsType = (field.args.find((a) => a.name === 'args')!.type as GraphQLNonNull<GraphQLInputObjectType>).ofType as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['p_metadata']).toBeDefined();
      expect(argsFields['p_metadata'].type.toString()).toBe('Jsonb');
    });

    it('should use json scalar for json-typed function args', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['searchClientsAdvanced'];
      const argsType = (field.args.find((a) => a.name === 'args')!.type as GraphQLNonNull<GraphQLInputObjectType>).ofType as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['p_extra']).toBeDefined();
      expect(argsFields['p_extra'].type.toString()).toBe('json');
    });

    it('should use Bigint scalar for bigint-typed function args', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['searchClientsAdvanced'];
      const argsType = (field.args.find((a) => a.name === 'args')!.type as GraphQLNonNull<GraphQLInputObjectType>).ofType as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['p_limit']).toBeDefined();
      expect(argsFields['p_limit'].type.toString()).toBe('Bigint');
    });

    it('should use Bpchar scalar for bpchar-typed function args', () => {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()['searchClientsAdvanced'];
      const argsType = (field.args.find((a) => a.name === 'args')!.type as GraphQLNonNull<GraphQLInputObjectType>).ofType as GraphQLInputObjectType;
      const argsFields = argsType.getFields();
      expect(argsFields['p_brand_code']).toBeDefined();
      expect(argsFields['p_brand_code'].type.toString()).toBe('Bpchar');
    });
  });

  describe('Relationship cardinality from metadata (P10.8)', () => {
    it('should produce object (singular) type for Player.lock defined as object_relationship with reverse FK', () => {
      const typeMap = schema.getTypeMap();
      const playerType = typeMap['Player'] as GraphQLObjectType;
      expect(playerType).toBeDefined();
      const fields = playerType.getFields();
      // lock is defined as an object_relationship in metadata using the
      // { table, column } form (reverse-FK / 1:1 pattern)
      expect(fields['lock']).toBeDefined();
      const lockType = fields['lock'].type;
      // Must NOT be a list — object relationships are singular types
      expect(lockType).not.toBeInstanceOf(GraphQLList);
      // The inner type (unwrapped from possible NonNull) should be PlayerLock
      const unwrapped = lockType instanceof GraphQLNonNull
        ? (lockType as GraphQLNonNull<any>).ofType
        : lockType;
      expect(unwrapped).toBeInstanceOf(GraphQLObjectType);
      expect((unwrapped as GraphQLObjectType).name).toBe('PlayerLock');
    });

    it('should not produce an array (list) type for Player.lock', () => {
      const typeMap = schema.getTypeMap();
      const playerType = typeMap['Player'] as GraphQLObjectType;
      const fields = playerType.getFields();
      const lockType = fields['lock'].type;
      // Unwrap NonNull if present
      const inner = lockType instanceof GraphQLNonNull
        ? (lockType as GraphQLNonNull<any>).ofType
        : lockType;
      // The type must not be a list at any level
      expect(inner).not.toBeInstanceOf(GraphQLList);
    });

    it('should correctly resolve PlayerLock.player as object relationship', () => {
      const typeMap = schema.getTypeMap();
      const playerLockType = typeMap['PlayerLock'] as GraphQLObjectType;
      expect(playerLockType).toBeDefined();
      const fields = playerLockType.getFields();
      // player is defined as object_relationship using simple FK column form
      expect(fields['player']).toBeDefined();
      const playerFieldType = fields['player'].type;
      // Should be non-null (player_id is NOT NULL)
      expect(playerFieldType).toBeInstanceOf(GraphQLNonNull);
      const innerType = (playerFieldType as GraphQLNonNull<any>).ofType;
      expect(innerType).toBeInstanceOf(GraphQLObjectType);
      expect((innerType as GraphQLObjectType).name).toBe('Player');
    });

    it('should store correct relationship extensions for reverse-FK object relationship', () => {
      const typeMap = schema.getTypeMap();
      const playerType = typeMap['Player'] as GraphQLObjectType;
      const lockField = playerType.getFields()['lock'];
      expect(lockField.extensions).toBeDefined();
      expect(lockField.extensions['relationshipType']).toBe('object');
      expect(lockField.extensions['isRelationship']).toBe(true);
      // remoteColumns should contain the FK column on the remote table
      expect(lockField.extensions['remoteColumns']).toContain('player_id');
    });

    it('should have correct localColumns inferred for reverse-FK object relationship', () => {
      // The local columns (on player) should be inferred from the FK: player.id
      const playerTable = schemaModel.tables.find((t) => t.name === 'player');
      expect(playerTable).toBeDefined();
      const lockRel = playerTable!.relationships.find((r) => r.name === 'lock');
      expect(lockRel).toBeDefined();
      expect(lockRel!.type).toBe('object');
      expect(lockRel!.remoteColumns).toEqual(['player_id']);
      // localColumns should be inferred from the FK: player_lock.player_id -> player.id
      expect(lockRel!.localColumns).toEqual(['id']);
    });
  });
});
