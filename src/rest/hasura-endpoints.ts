/**
 * Hasura-compatible REST endpoints.
 *
 * Registers Fastify routes that map to named GraphQL queries stored in
 * query collections. Each route resolves variables from the request
 * body (POST) or query parameters (GET), then executes the referenced
 * GraphQL query through Mercurius's app.graphql() API.
 */

import { parse } from 'graphql';
import type { TypeNode } from 'graphql';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { QueryCollection, HasuraRestEndpoint } from '../types.js';
import type { MercuriusFastifyInstance, MercuriusExecutionError } from '../server/types.js';

const BASE_PATH = '/api/rest';

// ─── Variable type coercion ─────────────────────────────────────────────────
//
// Query strings and route params are always strings, but the named query may
// declare non-String variables ($limit: Int, $active: Boolean, ...). Hasura
// coerces such params to the declared variable types before executing; without
// this a query declaring `$active: Boolean` receives "true" and validation
// rejects it.

/**
 * Extract variable type nodes from a GraphQL query string.
 * Returns an empty map when the query cannot be parsed — coercion is then a
 * no-op and GraphQL execution reports the parse error as before.
 */
function extractVariableTypes(queryString: string): Map<string, TypeNode> {
  const varTypes = new Map<string, TypeNode>();
  try {
    const doc = parse(queryString);
    for (const def of doc.definitions) {
      if (def.kind !== 'OperationDefinition') continue;
      for (const varDef of def.variableDefinitions ?? []) {
        varTypes.set(varDef.variable.name.value, varDef.type);
      }
    }
  } catch {
    // Unparseable query — leave variables untouched
  }
  return varTypes;
}

/**
 * Coerce a single string value to the declared variable type.
 * Only Boolean, Int, and Float are coerced; String, ID, and custom scalars
 * pass through untouched. Values that don't parse cleanly are left as-is so
 * GraphQL validation rejects them with its usual error.
 */
function coerceValue(value: unknown, typeNode: TypeNode): unknown {
  if (typeNode.kind === 'NonNullType') {
    return coerceValue(value, typeNode.type);
  }
  if (typeNode.kind === 'ListType') {
    // Repeated query params arrive as arrays; a single value is wrapped
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => coerceValue(item, typeNode.type));
  }
  if (typeof value !== 'string') return value;

  switch (typeNode.name.value) {
    case 'Int':
      return /^-?\d+$/.test(value) ? parseInt(value, 10) : value;
    case 'Float': {
      const num = Number(value);
      return value.trim() !== '' && Number.isFinite(num) ? num : value;
    }
    case 'Boolean':
      return value === 'true' ? true : value === 'false' ? false : value;
    default:
      // String, ID, and custom scalars accept string input as-is
      return value;
  }
}

/** Coerce variables against a pre-extracted variable type map. */
function coerceVariables(
  variables: Record<string, unknown>,
  varTypes: Map<string, TypeNode>,
): Record<string, unknown> {
  if (varTypes.size === 0) return variables;
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(variables)) {
    const typeNode = varTypes.get(name);
    result[name] = typeNode ? coerceValue(value, typeNode) : value;
  }
  return result;
}

/**
 * Coerce string variables (from query/route params) to the types the query's
 * variable definitions declare. Exposed for testing; route handlers use the
 * same logic with the type map extracted once at registration.
 */
export function coerceRestVariables(
  variables: Record<string, unknown>,
  queryString: string,
): Record<string, unknown> {
  return coerceVariables(variables, extractVariableTypes(queryString));
}

export interface HasuraRestDeps {
  /** Build the Mercurius/resolver context object from a Fastify request */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildContext: (request: FastifyRequest) => Record<string, any>;
}

/**
 * Register Hasura-style REST endpoint routes on the Fastify instance.
 */
export function registerHasuraRestEndpoints(
  fastify: MercuriusFastifyInstance,
  queryCollections: QueryCollection[],
  endpoints: HasuraRestEndpoint[],
  deps: HasuraRestDeps,
): void {
  if (endpoints.length === 0) return;

  // Build a quick lookup: collectionName -> queryName -> query string
  const queryLookup = new Map<string, Map<string, string>>();
  for (const col of queryCollections) {
    queryLookup.set(col.name, col.queries);
  }

  for (const endpoint of endpoints) {
    const queries = queryLookup.get(endpoint.collectionName);
    if (!queries) continue;
    const queryString = queries.get(endpoint.queryName);
    if (!queryString) continue;

    // Normalize URL: ensure it starts with / and does not end with /
    let urlPath = endpoint.url;
    if (!urlPath.startsWith('/')) {
      urlPath = '/' + urlPath;
    }
    urlPath = urlPath.replace(/\/+$/, '');

    const fullPath = `${BASE_PATH}${urlPath}`;

    // Variable types declared by the named query, for param coercion
    const varTypes = extractVariableTypes(queryString);

    for (const method of endpoint.methods) {
      const upperMethod = method.toUpperCase();

      const handler = async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          // Build variables from POST body or GET query params
          let variables: Record<string, unknown> = {};

          if (upperMethod === 'GET') {
            // GET: variables come from query parameters
            const queryParams = request.query as Record<string, string>;
            variables = { ...queryParams };
            // Also merge route params (e.g., :id, :clientId)
            if (request.params && typeof request.params === 'object') {
              variables = { ...variables, ...(request.params as Record<string, unknown>) };
            }
            // Query/route params are strings — coerce to declared variable types
            variables = coerceVariables(variables, varTypes);
          } else {
            // POST/PUT/PATCH/DELETE: variables come from the request body
            if (request.body && typeof request.body === 'object') {
              variables = request.body as Record<string, unknown>;
            }
            // Also merge route params, coerced to declared variable types
            // (the JSON body already carries typed values)
            if (request.params && typeof request.params === 'object') {
              variables = {
                ...variables,
                ...coerceVariables(request.params as Record<string, unknown>, varTypes),
              };
            }
          }

          // Build the Mercurius resolver context from the request
          const context = deps.buildContext(request);

          // Execute the GraphQL query through Mercurius
          const result = await fastify.graphql(queryString, context, variables);

          // Hasura REST endpoints return the contents of `data` directly,
          // without the GraphQL `{ data }` envelope (encodeHTTPResp in
          // Hasura.GraphQL.Transport.HTTP.Protocol). Errors use Hasura's API
          // error format with a real HTTP status — REST routes encode QErrs
          // with `encodeQErr id`, unlike /v1/graphql which forces 200.
          if (result.errors && result.errors.length > 0) {
            void reply.code(400).send({
              path: '$',
              error: result.errors[0].message,
              code: 'validation-failed',
            });
          } else {
            void reply.code(200).send(result.data);
          }
        } catch (err) {
          request.log.error({ err, endpoint: endpoint.name }, 'Error executing Hasura REST endpoint');
          // Mercurius throws errors with statusCode and errors properties for
          // validation failures — Hasura reports these as 400 validation-failed
          const mercErr = err as MercuriusExecutionError;
          if (mercErr.errors && mercErr.errors.length > 0) {
            void reply.code(400).send({
              path: '$',
              error: mercErr.errors[0].message,
              code: 'validation-failed',
            });
          } else {
            const message = err instanceof Error ? err.message : 'Internal server error';
            void reply.code(500).send({
              path: '$',
              error: message,
              code: 'unexpected',
            });
          }
        }
      };

      switch (upperMethod) {
        case 'GET':
          fastify.get(fullPath, handler);
          break;
        case 'POST':
          fastify.post(fullPath, handler);
          break;
        case 'PUT':
          fastify.put(fullPath, handler);
          break;
        case 'PATCH':
          fastify.patch(fullPath, handler);
          break;
        case 'DELETE':
          fastify.delete(fullPath, handler);
          break;
        default:
          fastify.log.warn({ method: upperMethod, endpoint: endpoint.name }, 'Unsupported HTTP method for Hasura REST endpoint');
      }
    }
  }

  fastify.log.info({ count: endpoints.length }, 'Hasura REST endpoints registered');
}
