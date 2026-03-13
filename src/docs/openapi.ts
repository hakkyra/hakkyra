/**
 * OpenAPI 3.1 specification generator.
 *
 * Generates an OpenAPI spec from tracked tables, including:
 * - Path definitions for all REST endpoints
 * - Schema definitions from table columns
 * - Security scheme (JWT Bearer)
 * - Filter parameter documentation
 * - LLM-friendly extensions (x-llm-description, x-llm-usage)
 */

import type { TableInfo, ColumnInfo, RESTConfig } from '../types.js';

// ─── OpenAPI types (subset of OpenAPI 3.1) ───────────────────────────────────

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
    'x-llm-description'?: string;
  };
  servers: { url: string; description?: string }[];
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, SchemaObject>;
    securitySchemes: Record<string, SecurityScheme>;
    parameters: Record<string, ParameterObject>;
  };
  security: SecurityRequirement[];
}

interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

interface OperationObject {
  summary: string;
  description?: string;
  operationId: string;
  tags: string[];
  parameters?: (ParameterObject | RefObject)[];
  requestBody?: RequestBody;
  responses: Record<string, ResponseObject>;
  'x-llm-usage'?: string;
}

interface ParameterObject {
  name: string;
  in: 'query' | 'path' | 'header';
  required?: boolean;
  schema: SchemaObject;
  description?: string;
  example?: unknown;
}

interface RequestBody {
  required: boolean;
  content: Record<string, { schema: SchemaObject | RefObject }>;
}

interface ResponseObject {
  description: string;
  content?: Record<string, { schema: SchemaObject | RefObject }>;
}

interface SchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaObject | RefObject>;
  items?: SchemaObject | RefObject;
  required?: string[];
  description?: string;
  enum?: string[];
  nullable?: boolean;
  example?: unknown;
}

interface RefObject {
  $ref: string;
}

interface SecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
}

interface SecurityRequirement {
  [name: string]: string[];
}

// ─── PG type → JSON Schema type mapping ─────────────────────────────────────

function pgTypeToJsonSchema(column: ColumnInfo): SchemaObject {
  const base = mapBaseType(column.udtName);

  if (column.isArray) {
    return {
      type: 'array',
      items: base,
      nullable: column.isNullable,
    };
  }

  return {
    ...base,
    nullable: column.isNullable || undefined,
  };
}

function mapBaseType(udtName: string): SchemaObject {
  switch (udtName) {
    case 'int2':
    case 'int4':
    case 'serial':
    case 'serial4':
    case 'oid':
      return { type: 'integer', format: 'int32' };

    case 'int8':
    case 'bigserial':
    case 'serial8':
      return { type: 'integer', format: 'int64' };

    case 'float4':
      return { type: 'number', format: 'float' };

    case 'float8':
      return { type: 'number', format: 'double' };

    case 'numeric':
    case 'money':
      return { type: 'string', format: 'decimal', description: 'Arbitrary precision decimal number' };

    case 'bool':
      return { type: 'boolean' };

    case 'uuid':
      return { type: 'string', format: 'uuid' };

    case 'json':
    case 'jsonb':
      return { type: 'object', description: 'JSON value' };

    case 'date':
      return { type: 'string', format: 'date' };

    case 'time':
    case 'timetz':
      return { type: 'string', format: 'time' };

    case 'timestamp':
    case 'timestamptz':
      return { type: 'string', format: 'date-time' };

    case 'interval':
      return { type: 'string', format: 'duration' };

    case 'bytea':
      return { type: 'string', format: 'byte', description: 'Base64-encoded binary data' };

    case 'inet':
    case 'cidr':
      return { type: 'string', format: 'ipv4' };

    case 'text':
    case 'varchar':
    case 'char':
    case 'bpchar':
    case 'name':
    case 'citext':
    case 'macaddr':
    default:
      return { type: 'string' };
  }
}

// ─── Schema builders ─────────────────────────────────────────────────────────

function getURLName(table: TableInfo): string {
  return table.alias ?? table.name;
}

function getSchemaName(table: TableInfo): string {
  const base = table.alias ?? table.name;
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function buildTableSchema(table: TableInfo): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  for (const column of table.columns) {
    properties[column.name] = pgTypeToJsonSchema(column);
    if (column.comment) {
      properties[column.name].description = column.comment;
    }
    if (column.enumValues && column.enumValues.length > 0) {
      properties[column.name].enum = column.enumValues;
    }
    if (!column.isNullable && !column.hasDefault) {
      required.push(column.name);
    }
  }

  return {
    type: 'object',
    description: table.comment ?? `Represents a row in ${table.schema}.${table.name}`,
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function buildInsertSchema(table: TableInfo): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  for (const column of table.columns) {
    // Skip auto-generated columns for insert schema
    if (column.isPrimaryKey && column.hasDefault) continue;

    properties[column.name] = pgTypeToJsonSchema(column);
    if (!column.isNullable && !column.hasDefault) {
      required.push(column.name);
    }
  }

  return {
    type: 'object',
    description: `Insert body for ${getURLName(table)}`,
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function buildUpdateSchema(table: TableInfo): SchemaObject {
  const properties: Record<string, SchemaObject> = {};

  for (const column of table.columns) {
    // Skip PK columns in update body
    if (column.isPrimaryKey) continue;
    properties[column.name] = pgTypeToJsonSchema(column);
  }

  return {
    type: 'object',
    description: `Partial update body for ${getURLName(table)}`,
    properties,
  };
}

// ─── Filter parameters ──────────────────────────────────────────────────────

function buildFilterParameters(table: TableInfo): ParameterObject[] {
  const params: ParameterObject[] = [];

  // Column filter parameters
  for (const column of table.columns) {
    params.push({
      name: column.name,
      in: 'query',
      required: false,
      schema: { type: 'string' },
      description: `Filter on ${column.name}. Syntax: op.value where op is eq, neq, gt, gte, lt, lte, in, is, like, ilike`,
      example: `eq.${column.udtName === 'int4' ? '42' : 'value'}`,
    });
  }

  return params;
}

function buildCommonQueryParameters(): ParameterObject[] {
  return [
    {
      name: 'order',
      in: 'query',
      required: false,
      schema: { type: 'string' },
      description: 'Order results. Syntax: column.asc or column.desc. Multiple: col1.asc,col2.desc',
      example: 'created_at.desc',
    },
    {
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'integer' },
      description: 'Maximum number of rows to return',
      example: 20,
    },
    {
      name: 'offset',
      in: 'query',
      required: false,
      schema: { type: 'integer' },
      description: 'Number of rows to skip',
      example: 0,
    },
    {
      name: 'select',
      in: 'query',
      required: false,
      schema: { type: 'string' },
      description: 'Comma-separated list of columns to return',
      example: 'id,name,email',
    },
  ];
}

// ─── Path builders ───────────────────────────────────────────────────────────

function buildTablePaths(
  table: TableInfo,
  basePath: string,
  config: RESTConfig,
): Record<string, PathItem> {
  const urlName = getURLName(table);
  const schemaName = getSchemaName(table);
  const paths: Record<string, PathItem> = {};

  const listPath = `${basePath}/${urlName}`;
  const itemPath = `${basePath}/${urlName}/{id}`;

  // List endpoint
  const listOperation: OperationObject = {
    summary: `List ${urlName}`,
    description: `Retrieve a filtered, paginated list of ${urlName} records. Supports PostgREST-style filtering.`,
    operationId: `list${schemaName}`,
    tags: [urlName],
    parameters: [
      ...buildCommonQueryParameters(),
      ...buildFilterParameters(table),
    ],
    responses: {
      '200': {
        description: `Array of ${urlName} records`,
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        },
      },
      '400': { description: 'Bad request — invalid filter syntax' },
      '401': { description: 'Unauthorized — authentication required' },
      '403': { description: 'Forbidden — insufficient permissions' },
    },
    'x-llm-usage': `Fetch ${urlName} rows. Filter with query params like ?column=op.value`,
  };

  paths[listPath] = { get: listOperation };

  if (table.primaryKey.length === 0) {
    return paths;
  }

  // Get by PK
  const getOperation: OperationObject = {
    summary: `Get ${urlName} by ID`,
    description: `Retrieve a single ${urlName} record by its primary key.${table.primaryKey.length > 1 ? ' For composite keys, separate values with commas.' : ''}`,
    operationId: `get${schemaName}`,
    tags: [urlName],
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: table.primaryKey.length > 1
          ? `Composite primary key: ${table.primaryKey.join(',')}`
          : `Primary key (${table.primaryKey[0]})`,
      },
    ],
    responses: {
      '200': {
        description: `A single ${urlName} record`,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${schemaName}` },
          },
        },
      },
      '404': { description: 'Not found' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
    },
    'x-llm-usage': `Fetch a single ${urlName} by primary key`,
  };

  // Insert
  const insertOperation: OperationObject = {
    summary: `Create ${urlName}`,
    description: `Insert a new ${urlName} record.`,
    operationId: `create${schemaName}`,
    tags: [urlName],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${schemaName}Insert` },
        },
      },
    },
    responses: {
      '201': {
        description: `Created ${urlName} record`,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${schemaName}` },
          },
        },
      },
      '400': { description: 'Bad request — invalid body or constraint violation' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
    },
    'x-llm-usage': `Create a new ${urlName}. Send JSON body with fields.`,
  };

  // Update
  const updateOperation: OperationObject = {
    summary: `Update ${urlName}`,
    description: `Partially update a ${urlName} record by primary key.`,
    operationId: `update${schemaName}`,
    tags: [urlName],
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: `Primary key${table.primaryKey.length > 1 ? ` (composite: ${table.primaryKey.join(',')})` : ''}`,
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${schemaName}Update` },
        },
      },
    },
    responses: {
      '200': {
        description: `Updated ${urlName} record`,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${schemaName}` },
          },
        },
      },
      '400': { description: 'Bad request' },
      '404': { description: 'Not found' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
    },
    'x-llm-usage': `Update ${urlName} fields. Only send fields to change.`,
  };

  // Delete
  const deleteOperation: OperationObject = {
    summary: `Delete ${urlName}`,
    description: `Delete a ${urlName} record by primary key.`,
    operationId: `delete${schemaName}`,
    tags: [urlName],
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: `Primary key`,
      },
    ],
    responses: {
      '200': {
        description: 'Deletion result with affected row count',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                affected_rows: { type: 'integer' },
              },
            },
          },
        },
      },
      '404': { description: 'Not found' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
    },
    'x-llm-usage': `Delete a ${urlName} by primary key`,
  };

  paths[itemPath] = {
    get: getOperation,
    patch: updateOperation,
    delete: deleteOperation,
  };

  // Add POST at the list path
  if (!paths[listPath]) {
    paths[listPath] = {};
  }
  paths[listPath].post = insertOperation;

  return paths;
}

// ─── Main generator ──────────────────────────────────────────────────────────

/**
 * Generate an OpenAPI 3.1 specification from tracked tables and REST config.
 *
 * The spec includes:
 * - Path definitions for all CRUD endpoints
 * - Schema definitions derived from PostgreSQL column types
 * - JWT Bearer security scheme
 * - PostgREST-style filter parameter documentation
 * - `x-llm-description` and `x-llm-usage` extensions for LLM consumption
 */
export function generateOpenAPISpec(tables: TableInfo[], config: RESTConfig): OpenAPISpec {
  const schemas: Record<string, SchemaObject> = {};
  const paths: Record<string, PathItem> = {};

  for (const table of tables) {
    const schemaName = getSchemaName(table);

    // Build schemas
    schemas[schemaName] = buildTableSchema(table);
    schemas[`${schemaName}Insert`] = buildInsertSchema(table);
    schemas[`${schemaName}Update`] = buildUpdateSchema(table);

    // Build paths
    const tablePaths = buildTablePaths(table, config.basePath.replace(/\/$/, ''), config);
    Object.assign(paths, tablePaths);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Hakkyra API',
      version: '1.0.0',
      description: 'Auto-generated REST API from PostgreSQL database schema. Supports PostgREST-style filtering, pagination, and column selection.',
      'x-llm-description': 'REST API with CRUD endpoints for database tables. Use query params for filtering (column=op.value), ordering (order=col.asc), pagination (limit=N&offset=N), and column selection (select=col1,col2). Auth via Bearer JWT.',
    },
    servers: [
      { url: '/', description: 'Current server' },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT Bearer token in Authorization header',
        },
      },
      parameters: {
        OrderParam: {
          name: 'order',
          in: 'query',
          schema: { type: 'string' },
          description: 'Ordering: column.asc or column.desc',
        },
        LimitParam: {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer' },
          description: 'Max rows to return',
        },
        OffsetParam: {
          name: 'offset',
          in: 'query',
          schema: { type: 'integer' },
          description: 'Rows to skip',
        },
        SelectParam: {
          name: 'select',
          in: 'query',
          schema: { type: 'string' },
          description: 'Comma-separated columns',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
