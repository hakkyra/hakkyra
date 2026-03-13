/**
 * LLM-friendly compact API description generator.
 *
 * Produces a minimal JSON structure optimized for token efficiency
 * when included in LLM context windows. Avoids verbose OpenAPI overhead
 * while capturing all the information an LLM needs to generate correct
 * API calls.
 */

import type { TableInfo, RESTConfig, RelationshipConfig } from '../types.js';

// ─── Output types ────────────────────────────────────────────────────────────

export interface LLMDoc {
  api: string;
  base: string;
  auth: string;
  filters: string;
  ordering: string;
  pagination: string;
  entities: LLMEntity[];
}

interface LLMEntity {
  name: string;
  fields: string[];
  pk: string[];
  endpoints: Record<string, string>;
  filters: string;
  relations: string[];
}

// ─── PG type → compact type label ───────────────────────────────────────────

function compactType(udtName: string, isArray: boolean): string {
  let base: string;

  switch (udtName) {
    case 'int2':
    case 'int4':
    case 'serial':
    case 'serial4':
    case 'oid':
      base = 'int';
      break;
    case 'int8':
    case 'bigserial':
    case 'serial8':
      base = 'bigint';
      break;
    case 'float4':
    case 'float8':
      base = 'float';
      break;
    case 'numeric':
    case 'money':
      base = 'decimal';
      break;
    case 'bool':
      base = 'bool';
      break;
    case 'uuid':
      base = 'uuid';
      break;
    case 'json':
    case 'jsonb':
      base = 'json';
      break;
    case 'date':
      base = 'date';
      break;
    case 'time':
    case 'timetz':
      base = 'time';
      break;
    case 'timestamp':
    case 'timestamptz':
      base = 'datetime';
      break;
    case 'interval':
      base = 'interval';
      break;
    case 'bytea':
      base = 'bytes';
      break;
    case 'inet':
    case 'cidr':
      base = 'ip';
      break;
    case 'text':
    case 'varchar':
    case 'char':
    case 'bpchar':
    case 'name':
    case 'citext':
    default:
      base = 'string';
      break;
  }

  return isArray ? `${base}[]` : base;
}

// ─── Relationship label ─────────────────────────────────────────────────────

function relationLabel(rel: RelationshipConfig): string {
  const relType = rel.type === 'array' ? 'has_many' : 'has_one';
  return `${rel.name}:${relType}`;
}

// ─── Main generator ──────────────────────────────────────────────────────────

/**
 * Generate a compact, LLM-friendly API description.
 *
 * The output is a minimal JSON structure that captures:
 * - Entity names and field types
 * - CRUD endpoint URLs
 * - Filter/ordering/pagination syntax
 * - Relationships between entities
 *
 * Designed for maximum information density with minimum token usage
 * when injected into an LLM context window.
 */
export function generateLLMDoc(tables: TableInfo[], config: RESTConfig): LLMDoc {
  const basePath = config.basePath.replace(/\/$/, '');

  const entities: LLMEntity[] = tables.map((table) => {
    const urlName = table.alias ?? table.name;

    // Compact field descriptors: "column_name:type"
    const fields = table.columns.map((col) => {
      const type = compactType(col.udtName, col.isArray);
      const suffix = col.isNullable ? '?' : '';
      return `${col.name}:${type}${suffix}`;
    });

    // Endpoints
    const endpoints: Record<string, string> = {
      list: `GET ${basePath}/${urlName}`,
    };

    if (table.primaryKey.length > 0) {
      endpoints.get = `GET ${basePath}/${urlName}/:id`;
      endpoints.create = `POST ${basePath}/${urlName}`;
      endpoints.update = `PATCH ${basePath}/${urlName}/:id`;
      endpoints.delete = `DELETE ${basePath}/${urlName}/:id`;
    }

    // Relationships
    const relations = table.relationships.map(relationLabel);

    return {
      name: urlName,
      fields,
      pk: table.primaryKey,
      endpoints,
      filters: 'field=op.value where op: eq,neq,gt,gte,lt,lte,in,is,like,ilike',
      relations,
    };
  });

  return {
    api: 'hakkyra',
    base: basePath,
    auth: 'Bearer JWT in Authorization header',
    filters: 'column=op.value (eq,neq,gt,gte,lt,lte,in.(a,b),is.null,like.*pat*,ilike.*pat*)',
    ordering: 'order=col.asc or order=col.desc (multiple: col1.asc,col2.desc)',
    pagination: `limit=N&offset=N (default limit: ${config.pagination.defaultLimit}, max: ${config.pagination.maxLimit})`,
    entities,
  };
}
