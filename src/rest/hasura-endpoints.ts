/**
 * Hasura-compatible REST endpoints.
 *
 * Registers Fastify routes that map to named GraphQL queries stored in
 * query collections. Each route resolves variables from the request
 * body (POST) or query parameters (GET), then executes the referenced
 * GraphQL query through Mercurius's app.graphql() API.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { QueryCollection, HasuraRestEndpoint } from '../types.js';

const BASE_PATH = '/api/rest';

export interface HasuraRestDeps {
  /** Build the Mercurius/resolver context object from a Fastify request */
  buildContext: (request: FastifyRequest) => Record<string, unknown>;
}

/**
 * Register Hasura-style REST endpoint routes on the Fastify instance.
 */
export function registerHasuraRestEndpoints(
  fastify: FastifyInstance,
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
          } else {
            // POST/PUT/PATCH/DELETE: variables come from the request body
            if (request.body && typeof request.body === 'object') {
              variables = request.body as Record<string, unknown>;
            }
            // Also merge route params
            if (request.params && typeof request.params === 'object') {
              variables = { ...variables, ...(request.params as Record<string, unknown>) };
            }
          }

          // Build the Mercurius resolver context from the request
          const context = deps.buildContext(request);

          // Execute the GraphQL query through Mercurius
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (fastify as any).graphql(queryString, context, variables);

          void reply.code(200).send(result);
        } catch (err) {
          request.log.error({ err, endpoint: endpoint.name }, 'Error executing Hasura REST endpoint');
          // Mercurius throws errors with statusCode and errors properties for
          // validation failures — return them as standard GraphQL error responses
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mercErr = err as any;
          if (mercErr?.statusCode && mercErr?.errors) {
            void reply.code(200).send({
              data: null,
              errors: mercErr.errors,
            });
          } else {
            const message = err instanceof Error ? err.message : 'Internal server error';
            void reply.code(500).send({
              errors: [{ message }],
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
