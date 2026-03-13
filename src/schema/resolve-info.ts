/**
 * Parses GraphQL ResolveInfo to extract requested columns and relationships.
 *
 * Walks the selection set of the current field to determine:
 * - Which scalar columns were requested (mapped to snake_case for the SQL compiler)
 * - Which relationship fields were requested, including their sub-selections and arguments
 *
 * This allows the SQL compiler to embed relationship subqueries directly in the
 * top-level SELECT, avoiding N+1 queries.
 */

import type {
  GraphQLResolveInfo,
  FieldNode,
  SelectionNode,
  FragmentSpreadNode,
  InlineFragmentNode,
} from 'graphql';
import type {
  TableInfo,
  BoolExp,
  SessionVariables,
} from '../types.js';
import type { RelationshipSelection, OrderByItem } from '../sql/select.js';
import type { ResolverPermissionLookup } from './resolvers.js';
import { toCamelCase } from './type-builder.js';

// ─── Public Interface ────────────────────────────────────────────────────────

export interface ParsedSelection {
  /** snake_case column names requested */
  columns: string[];
  /** Nested relationship selections */
  relationships: RelationshipSelection[];
}

// ─── camelCase → snake_case column map ───────────────────────────────────────

/**
 * Build a mapping of camelCase field names to snake_case column names.
 */
function camelToColumnMap(table: TableInfo): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of table.columns) {
    map.set(toCamelCase(col.name), col.name);
  }
  return map;
}

/**
 * Build a mapping of relationship name to RelationshipConfig.
 */
function relationshipMap(table: TableInfo): Map<string, TableInfo['relationships'][number]> {
  const map = new Map<string, TableInfo['relationships'][number]>();
  for (const rel of table.relationships) {
    map.set(rel.name, rel);
  }
  return map;
}

// ─── Argument Parsing ────────────────────────────────────────────────────────

/**
 * Extract the value of a named argument from a FieldNode, resolving variables.
 */
function getArgumentValue(
  fieldNode: FieldNode,
  argName: string,
  variableValues: Record<string, unknown>,
): unknown {
  if (!fieldNode.arguments) return undefined;
  const arg = fieldNode.arguments.find((a) => a.name.value === argName);
  if (!arg) return undefined;
  return resolveValueNode(arg.value, variableValues);
}

/**
 * Resolve a GraphQL ValueNode into a plain JS value.
 */
function resolveValueNode(
  valueNode: { kind: string; value?: unknown; values?: unknown[]; fields?: unknown[]; name?: { value: string } },
  variableValues: Record<string, unknown>,
): unknown {
  switch (valueNode.kind) {
    case 'Variable':
      return variableValues[(valueNode.name as { value: string }).value];
    case 'IntValue':
      return parseInt(valueNode.value as string, 10);
    case 'FloatValue':
      return parseFloat(valueNode.value as string);
    case 'StringValue':
      return valueNode.value;
    case 'BooleanValue':
      return valueNode.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return valueNode.value;
    case 'ListValue':
      return (valueNode.values as Array<{ kind: string; value?: unknown; values?: unknown[]; fields?: unknown[]; name?: { value: string } }>)
        .map((v) => resolveValueNode(v, variableValues));
    case 'ObjectValue': {
      const obj: Record<string, unknown> = {};
      for (const field of (valueNode.fields as Array<{ name: { value: string }; value: { kind: string; value?: unknown; values?: unknown[]; fields?: unknown[]; name?: { value: string } } }>)) {
        obj[field.name.value] = resolveValueNode(field.value, variableValues);
      }
      return obj;
    }
    default:
      return undefined;
  }
}

/**
 * Remap camelCase keys in an object to snake_case using a column map.
 */
function remapObjectKeys(
  obj: Record<string, unknown> | undefined,
  colMap: Map<string, string>,
): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const pgName = colMap.get(key) ?? key;
    result[pgName] = value;
  }
  return result;
}

/**
 * Recursively remap camelCase keys in a BoolExp to snake_case column names.
 * Logical operators (_and, _or, _not) and comparison operators (_eq, _gt, etc.)
 * are preserved as-is; only column-level keys are remapped.
 */
function remapBoolExp(
  boolExp: BoolExp | undefined | null,
  columnMap: Map<string, string>,
): BoolExp | undefined {
  if (!boolExp || typeof boolExp !== 'object') return undefined;

  const keys = Object.keys(boolExp);
  if (keys.length === 0) return boolExp;

  if ('_and' in boolExp) {
    const typed = boolExp as { _and: BoolExp[] };
    return { _and: typed._and.map((sub) => remapBoolExp(sub, columnMap) ?? ({} as BoolExp)) };
  }

  if ('_or' in boolExp) {
    const typed = boolExp as { _or: BoolExp[] };
    return { _or: typed._or.map((sub) => remapBoolExp(sub, columnMap) ?? ({} as BoolExp)) };
  }

  if ('_not' in boolExp) {
    const typed = boolExp as { _not: BoolExp };
    return { _not: remapBoolExp(typed._not, columnMap) ?? ({} as BoolExp) };
  }

  if ('_exists' in boolExp) {
    return boolExp;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(boolExp as Record<string, unknown>)) {
    const pgName = columnMap.get(key) ?? key;
    result[pgName] = value;
  }
  return result as BoolExp;
}

/**
 * Convert camelCase orderBy args from GraphQL to the OrderByItem[] the SQL compiler expects.
 */
function remapOrderBy(
  orderBy: Array<Record<string, string>> | undefined | null,
  columnMap: Map<string, string>,
): OrderByItem[] | undefined {
  if (!orderBy || !Array.isArray(orderBy) || orderBy.length === 0) return undefined;

  return orderBy.map((item) => {
    for (const [camelKey, direction] of Object.entries(item)) {
      const pgName = columnMap.get(camelKey) ?? camelKey;
      const parts = (direction as string).toLowerCase().split('_');
      const dir = parts[0] === 'desc' ? 'desc' : 'asc';
      let nulls: 'first' | 'last' | undefined;
      if (parts.includes('nulls') && parts.includes('first')) {
        nulls = 'first';
      } else if (parts.includes('nulls') && parts.includes('last')) {
        nulls = 'last';
      }
      return { column: pgName, direction: dir as 'asc' | 'desc', nulls };
    }
    return { column: '', direction: 'asc' as const };
  });
}

// ─── Main Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a GraphQL ResolveInfo to extract the requested columns and relationships
 * for a given table.
 *
 * @param info            The GraphQL ResolveInfo from the resolver
 * @param table           The table this query targets
 * @param allTables       All tracked tables (for resolving relationship remote tables)
 * @param permissionLookup Permission lookup for the remote tables
 * @param session         Current session variables (for role-based permission)
 * @returns Parsed selection with columns and relationships
 */
export function parseResolveInfo(
  info: GraphQLResolveInfo,
  table: TableInfo,
  allTables: TableInfo[],
  permissionLookup: ResolverPermissionLookup,
  session: SessionVariables,
): ParsedSelection {
  const fieldNode = info.fieldNodes[0];
  if (!fieldNode.selectionSet) {
    return { columns: table.columns.map((c) => c.name), relationships: [] };
  }

  return parseSelectionSet(
    fieldNode.selectionSet.selections,
    fieldNode,
    table,
    allTables,
    permissionLookup,
    session,
    info.variableValues as Record<string, unknown>,
    info.fragments,
  );
}

/**
 * Parse a selection set within a specific context — used for both top-level
 * and nested relationship parsing.
 */
function parseSelectionSet(
  selections: readonly SelectionNode[],
  parentFieldNode: FieldNode | null,
  table: TableInfo,
  allTables: TableInfo[],
  permissionLookup: ResolverPermissionLookup,
  session: SessionVariables,
  variableValues: Record<string, unknown>,
  fragments: GraphQLResolveInfo['fragments'],
): ParsedSelection {
  const colMap = camelToColumnMap(table);
  const relMap = relationshipMap(table);
  const columnSet = new Set<string>();
  const relationships: RelationshipSelection[] = [];

  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const fieldName = selection.name.value;

      // Skip __typename introspection field
      if (fieldName === '__typename') continue;

      // Check if it's a relationship
      const rel = relMap.get(fieldName);
      if (rel) {
        // Find the remote table
        const remoteTable = allTables.find(
          (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
        );
        if (!remoteTable) continue;

        // Parse the sub-selection recursively
        let subSelection: ParsedSelection;
        if (selection.selectionSet) {
          subSelection = parseSelectionSet(
            selection.selectionSet.selections,
            selection,
            remoteTable,
            allTables,
            permissionLookup,
            session,
            variableValues,
            fragments,
          );
        } else {
          subSelection = {
            columns: remoteTable.columns.map((c) => c.name),
            relationships: [],
          };
        }

        // Look up permissions for the remote table
        const remotePerm = session.isAdmin
          ? undefined
          : permissionLookup.getSelect(remoteTable.schema, remoteTable.name, session.role);

        // For non-admin, if there's no permission on the remote table, skip this relationship
        if (!session.isAdmin && !remotePerm) continue;

        // Build the RelationshipSelection
        const relSelection: RelationshipSelection = {
          relationship: rel,
          remoteTable,
          columns: subSelection.columns,
          relationships: subSelection.relationships.length > 0
            ? subSelection.relationships
            : undefined,
          permission: remotePerm ? {
            filter: remotePerm.filter,
            columns: remotePerm.columns,
            limit: remotePerm.limit,
          } : undefined,
        };

        // For array relationships, parse where/orderBy/limit/offset arguments
        if (rel.type === 'array') {
          const remoteColMap = camelToColumnMap(remoteTable);

          const whereArg = getArgumentValue(selection, 'where', variableValues);
          if (whereArg) {
            relSelection.where = remapBoolExp(whereArg as BoolExp, remoteColMap);
          }

          const orderByArg = getArgumentValue(selection, 'orderBy', variableValues);
          if (orderByArg) {
            relSelection.orderBy = remapOrderBy(
              orderByArg as Array<Record<string, string>>,
              remoteColMap,
            );
          }

          const limitArg = getArgumentValue(selection, 'limit', variableValues);
          if (limitArg !== undefined && limitArg !== null) {
            relSelection.limit = limitArg as number;
          }

          const offsetArg = getArgumentValue(selection, 'offset', variableValues);
          if (offsetArg !== undefined && offsetArg !== null) {
            relSelection.offset = offsetArg as number;
          }
        }

        relationships.push(relSelection);
      } else {
        // It's a scalar column — map camelCase to snake_case
        const pgName = colMap.get(fieldName);
        if (pgName) {
          columnSet.add(pgName);
        }
      }
    } else if (selection.kind === 'FragmentSpread') {
      // Handle fragment spreads
      const fragmentName = (selection as FragmentSpreadNode).name.value;
      const fragment = fragments[fragmentName];
      if (fragment) {
        const fragmentResult = parseSelectionSet(
          fragment.selectionSet.selections,
          parentFieldNode,
          table,
          allTables,
          permissionLookup,
          session,
          variableValues,
          fragments,
        );
        for (const col of fragmentResult.columns) {
          columnSet.add(col);
        }
        relationships.push(...fragmentResult.relationships);
      }
    } else if (selection.kind === 'InlineFragment') {
      // Handle inline fragments
      const inlineFragment = selection as InlineFragmentNode;
      const fragmentResult = parseSelectionSet(
        inlineFragment.selectionSet.selections,
        parentFieldNode,
        table,
        allTables,
        permissionLookup,
        session,
        variableValues,
        fragments,
      );
      for (const col of fragmentResult.columns) {
        columnSet.add(col);
      }
      relationships.push(...fragmentResult.relationships);
    }
  }

  // Always include primary key columns — they're needed for identity and relationships
  for (const pkCol of table.primaryKey) {
    columnSet.add(pkCol);
  }

  return {
    columns: Array.from(columnSet),
    relationships,
  };
}

/**
 * Parse the "nodes" sub-selection from an aggregate query's resolve info.
 *
 * The aggregate query has a shape like:
 *   playersAggregate { aggregate { count } nodes { id username wallets { ... } } }
 *
 * This function finds the "nodes" field in the top-level selection set and
 * parses its sub-selections as if it were a regular table query.
 */
export function parseAggregateNodesInfo(
  info: GraphQLResolveInfo,
  table: TableInfo,
  allTables: TableInfo[],
  permissionLookup: ResolverPermissionLookup,
  session: SessionVariables,
): ParsedSelection | null {
  const fieldNode = info.fieldNodes[0];
  if (!fieldNode.selectionSet) return null;

  const variableValues = info.variableValues as Record<string, unknown>;

  // Find the "nodes" field in the aggregate selection
  for (const selection of fieldNode.selectionSet.selections) {
    if (selection.kind === 'Field' && selection.name.value === 'nodes') {
      if (!selection.selectionSet) return null;

      return parseSelectionSet(
        selection.selectionSet.selections,
        selection,
        table,
        allTables,
        permissionLookup,
        session,
        variableValues,
        info.fragments,
      );
    }
  }

  return null;
}
