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
  FunctionInfo,
  CompiledFilter,
} from '../types.js';
import type { RelationshipSelection, OrderByItem } from '../sql/select.js';
import type { ResolverPermissionLookup } from './resolvers/index.js';
import { toCamelCase, getColumnFieldName, getRelFieldName } from './type-builder.js';

// ─── Public Interface ────────────────────────────────────────────────────────

export interface ParsedSelection {
  /** snake_case column names requested */
  columns: string[];
  /** Nested relationship selections */
  relationships: RelationshipSelection[];
  /** Scalar computed field names requested */
  computedFields?: string[];
  /** Set-returning computed field selections (array computed fields) */
  setReturningComputedFields?: SetReturningComputedFieldParsed[];
  /** Aggregate relationship selections ({rel}Aggregate fields on object types) */
  aggregateRelationships?: AggregateRelationshipParsed[];
  /** JSONB path arguments: snake_case column name → dot-separated path string */
  jsonbPaths?: Map<string, string>;
  /** User-provided arguments for scalar computed fields: snake_case cf name → { camelCaseArgName → value } */
  computedFieldArgs?: Map<string, Record<string, unknown>>;
}

export interface AggregateRelationshipParsed {
  /** camelCase field name (e.g., "invoicesAggregate") */
  fieldName: string;
  /** The relationship config */
  relationship: TableInfo['relationships'][number];
  /** The remote table */
  remoteTable: TableInfo;
  /** Whether count was requested */
  hasCount: boolean;
  /** Columns for count(columns: ...) */
  countColumns?: string[];
  /** Distinct flag for count(distinct: ...) */
  countDistinct?: boolean;
  /** Aggregate functions requested with their columns */
  aggregateFunctions: string[];
  /** User-provided where filter */
  where?: BoolExp;
  /** Permissions on the remote table */
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
}

export interface SetReturningComputedFieldParsed {
  /** snake_case computed field name */
  name: string;
  /** The table that the function returns rows from */
  remoteTable: TableInfo;
  /** Requested columns from the return table */
  columns: string[];
  /** Nested relationship selections from the return table */
  relationships: RelationshipSelection[];
  /** Nested scalar computed field names from the return table */
  computedFields?: string[];
  /** Nested set-returning computed fields from the return table */
  setReturningComputedFields?: SetReturningComputedFieldParsed[];
  /** JSONB path arguments: snake_case column name → dot-separated path string */
  jsonbPaths?: Map<string, string>;
  /** User-provided where filter */
  where?: BoolExp;
  /** User-provided order by */
  orderBy?: OrderByItem[];
  /** User-provided limit */
  limit?: number;
  /** User-provided offset */
  offset?: number;
  /** Permissions on the return table */
  permission?: {
    filter: CompiledFilter;
    columns: string[] | '*';
    limit?: number;
  };
}

// ─── camelCase → snake_case column map ───────────────────────────────────────

/**
 * Build a mapping of camelCase field names to snake_case column names.
 */
function camelToColumnMap(table: TableInfo): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of table.columns) {
    map.set(getColumnFieldName(table, col.name), col.name);
  }
  return map;
}

/**
 * Build a mapping of relationship name to RelationshipConfig.
 */
function relationshipMap(table: TableInfo): Map<string, TableInfo['relationships'][number]> {
  const map = new Map<string, TableInfo['relationships'][number]>();
  for (const rel of table.relationships) {
    map.set(getRelFieldName(rel), rel);
  }
  return map;
}

/**
 * Build a set of computed field camelCase names for quick lookup.
 */
function computedFieldCamelNames(table: TableInfo): Set<string> {
  const set = new Set<string>();
  if (table.computedFields) {
    for (const cf of table.computedFields) {
      set.add(toCamelCase(cf.name));
    }
  }
  return set;
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
  valueNode: { kind: string; value?: unknown; values?: readonly unknown[]; fields?: readonly unknown[]; name?: { value: string } },
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
 * Parse a direction string like 'asc', 'desc_nulls_first' etc.
 */
function parseDirection(direction: string): { direction: 'asc' | 'desc'; nulls?: 'first' | 'last' } {
  const parts = direction.toLowerCase().split('_');
  const dir = parts[0] === 'desc' ? 'desc' : 'asc';
  let nulls: 'first' | 'last' | undefined;
  if (parts.includes('nulls') && parts.includes('first')) {
    nulls = 'first';
  } else if (parts.includes('nulls') && parts.includes('last')) {
    nulls = 'last';
  }
  return { direction: dir, nulls };
}

/** Map of aggregate function camelCase name -> SQL function name */
const AGGREGATE_FN_MAP: Record<string, string> = {
  count: 'count',
  avg: 'avg',
  max: 'max',
  min: 'min',
  sum: 'sum',
  stddev: 'stddev',
  stddevPop: 'stddev_pop',
  stddevSamp: 'stddev_samp',
  varPop: 'var_pop',
  varSamp: 'var_samp',
  variance: 'variance',
};

/**
 * Convert camelCase orderBy args from GraphQL to the OrderByItem[] the SQL compiler expects.
 * Supports nested relationship ordering and aggregate ordering.
 */
function remapOrderBy(
  orderBy: Array<Record<string, unknown>> | undefined | null,
  columnMap: Map<string, string>,
  table?: TableInfo,
  allTables?: TableInfo[],
): OrderByItem[] | undefined {
  if (!orderBy || !Array.isArray(orderBy) || orderBy.length === 0) return undefined;

  const result: OrderByItem[] = [];

  for (const item of orderBy) {
    for (const [camelKey, value] of Object.entries(item)) {
      if (typeof value === 'string') {
        // Simple column ordering
        const pgName = columnMap.get(camelKey) ?? camelKey;
        const { direction, nulls } = parseDirection(value);
        result.push({ column: pgName, direction, nulls });
        continue;
      }

      if (typeof value === 'object' && value !== null && table && allTables) {
        const valueObj = value as Record<string, unknown>;

        // Check if this is an aggregate ordering (relNameAggregate)
        if (camelKey.endsWith('Aggregate')) {
          const relName = camelKey.slice(0, -'Aggregate'.length);
          const rel = table.relationships.find((r) => r.name === relName && r.type === 'array');
          if (!rel) continue;

          const remoteTable = allTables.find(
            (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
          );
          if (!remoteTable) continue;

          for (const [aggFnName, aggValue] of Object.entries(valueObj)) {
            if (aggFnName === 'count' && typeof aggValue === 'string') {
              const { direction, nulls } = parseDirection(aggValue);
              result.push({
                column: '',
                direction,
                nulls,
                aggregate: {
                  config: rel,
                  remoteTable,
                  function: 'count' as const,
                },
              });
            } else if (typeof aggValue === 'object' && aggValue !== null) {
              const sqlFn = AGGREGATE_FN_MAP[aggFnName];
              if (!sqlFn) continue;

              const remoteColMap = camelToColumnMap(remoteTable);
              for (const [colCamel, colDir] of Object.entries(aggValue as Record<string, string>)) {
                const colPg = remoteColMap.get(colCamel) ?? colCamel;
                const { direction, nulls } = parseDirection(colDir);
                result.push({
                  column: '',
                  direction,
                  nulls,
                  aggregate: {
                    config: rel,
                    remoteTable,
                    function: sqlFn as OrderByItem['aggregate'] extends { function: infer F } | undefined ? F : never,
                    column: colPg,
                  },
                });
              }
            }
          }
          continue;
        }

        // Check if this is an object relationship ordering
        const rel = table.relationships.find((r) => r.name === camelKey && r.type === 'object');
        if (rel) {
          const remoteTable = allTables.find(
            (t) => t.name === rel.remoteTable.name && t.schema === rel.remoteTable.schema,
          );
          if (!remoteTable) continue;

          const remoteColMap = camelToColumnMap(remoteTable);
          const nestedItems = remapOrderBy(
            [valueObj as Record<string, unknown>],
            remoteColMap,
            remoteTable,
            allTables,
          );

          if (nestedItems && nestedItems.length > 0) {
            for (const nested of nestedItems) {
              result.push({
                column: '',
                direction: nested.direction,
                nulls: nested.nulls,
                relationship: {
                  config: rel,
                  remoteTable,
                  orderByItem: nested,
                },
              });
            }
          }
          continue;
        }
      }
    }
  }

  return result.length > 0 ? result : undefined;
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
  functions?: FunctionInfo[],
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
    functions,
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
  functions?: FunctionInfo[],
): ParsedSelection {
  const colMap = camelToColumnMap(table);
  const relMap = relationshipMap(table);
  const cfNames = computedFieldCamelNames(table);
  const columnSet = new Set<string>();
  const relationships: RelationshipSelection[] = [];
  const computedFieldSet = new Set<string>();
  const setReturningComputedFieldList: SetReturningComputedFieldParsed[] = [];
  const aggregateRelationshipList: AggregateRelationshipParsed[] = [];
  const jsonbPaths = new Map<string, string>();
  const computedFieldArgsMap = new Map<string, Record<string, unknown>>();

  // Build a map of aggregate relationship field names
  // e.g., "invoicesAggregate" → invoices relationship config
  const aggRelMap = new Map<string, TableInfo['relationships'][number]>();
  for (const rel of table.relationships) {
    if (rel.type === 'array') {
      aggRelMap.set(`${getRelFieldName(rel)}Aggregate`, rel);
    }
  }

  // Build a set of JSONB/JSON column camelCase names for path argument detection
  const jsonbColumnCamelNames = new Set<string>();
  for (const col of table.columns) {
    if (!col.isArray && (col.udtName === 'jsonb' || col.udtName === 'json')) {
      jsonbColumnCamelNames.add(getColumnFieldName(table, col.name));
    }
  }

  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const fieldName = selection.name.value;

      // Skip __typename introspection field
      if (fieldName === '__typename') continue;

      // Check if it's a computed field
      if (cfNames.has(fieldName)) {
        // Find the original computed field config (snake_case)
        const cf = table.computedFields?.find((c) => toCamelCase(c.name) === fieldName);
        if (cf) {
          // Check if it's a set-returning computed field by looking up the function
          const fnSchema = cf.function.schema ?? 'public';
          const fn = functions?.find(
            (f) => f.name === cf.function.name && f.schema === fnSchema,
          );

          // Check if return type is a tracked table (handles both SETOF and non-SETOF composite returns)
          const returnsTrackedTable = fn && allTables.some(
            (t) => t.name === fn.returnType || `${t.schema}.${t.name}` === fn.returnType,
          );

          if ((fn?.isSetReturning || returnsTrackedTable) && selection.selectionSet) {
            // Find the return table
            const returnTable = allTables.find(
              (t) => t.name === fn.returnType || `${t.schema}.${t.name}` === fn.returnType,
            );

            if (returnTable) {
              // Parse sub-selections recursively against the return table
              const subParsed = parseSelectionSet(
                selection.selectionSet.selections,
                selection,
                returnTable,
                allTables,
                permissionLookup,
                session,
                variableValues,
                fragments,
                functions,
              );

              // Look up permissions for the return table
              const remotePerm = session.isAdmin
                ? undefined
                : permissionLookup.getSelect(returnTable.schema, returnTable.name, session.role);

              // Skip if non-admin and no permission on the return table
              if (!session.isAdmin && !remotePerm) continue;

              const srcfParsed: SetReturningComputedFieldParsed = {
                name: cf.name,
                remoteTable: returnTable,
                columns: subParsed.columns,
                relationships: subParsed.relationships,
                computedFields: subParsed.computedFields,
                setReturningComputedFields: subParsed.setReturningComputedFields,
                jsonbPaths: subParsed.jsonbPaths,
                permission: remotePerm ? {
                  filter: remotePerm.filter,
                  columns: remotePerm.columns,
                  limit: remotePerm.limit,
                } : undefined,
              };

              // Parse arguments (where, orderBy, limit, offset)
              const remoteColMap = camelToColumnMap(returnTable);

              const whereArg = getArgumentValue(selection, 'where', variableValues);
              if (whereArg) {
                srcfParsed.where = remapBoolExp(whereArg as BoolExp, remoteColMap);
              }

              const orderByArg = getArgumentValue(selection, 'orderBy', variableValues);
              if (orderByArg) {
                srcfParsed.orderBy = remapOrderBy(
                  orderByArg as Array<Record<string, unknown>>,
                  remoteColMap,
                  returnTable,
                  allTables,
                );
              }

              const limitArg = getArgumentValue(selection, 'limit', variableValues);
              if (limitArg !== undefined && limitArg !== null) {
                srcfParsed.limit = limitArg as number;
              }

              const offsetArg = getArgumentValue(selection, 'offset', variableValues);
              if (offsetArg !== undefined && offsetArg !== null) {
                srcfParsed.offset = offsetArg as number;
              }

              setReturningComputedFieldList.push(srcfParsed);
            }
          } else {
            // Scalar computed field
            computedFieldSet.add(cf.name);
            // Capture user-provided args (e.g., balanceInCurrency(args: { targetCurrency: "EUR" }))
            const cfArgsValue = getArgumentValue(selection, 'args', variableValues);
            if (cfArgsValue && typeof cfArgsValue === 'object' && cfArgsValue !== null) {
              computedFieldArgsMap.set(cf.name, cfArgsValue as Record<string, unknown>);
            }
          }
        }
        continue;
      }

      // Check if it's an aggregate relationship field (e.g., invoicesAggregate)
      const aggRel = aggRelMap.get(fieldName);
      if (aggRel) {
        const remoteTable = allTables.find(
          (t) => t.name === aggRel.remoteTable.name && t.schema === aggRel.remoteTable.schema,
        );
        if (!remoteTable) continue;

        // Look up permissions for the remote table
        const remotePerm = session.isAdmin
          ? undefined
          : permissionLookup.getSelect(remoteTable.schema, remoteTable.name, session.role);

        // For non-admin, if there's no permission on the remote table, skip
        if (!session.isAdmin && !remotePerm) continue;

        // Parse the where argument
        const remoteColMap = camelToColumnMap(remoteTable);
        const whereArg = getArgumentValue(selection, 'where', variableValues);
        const where = whereArg ? remapBoolExp(whereArg as BoolExp, remoteColMap) : undefined;

        // Parse count arguments from the sub-selection: aggregate { count(columns: ..., distinct: ...) }
        let countColumns: string[] | undefined;
        let countDistinct: boolean | undefined;
        if (selection.selectionSet) {
          for (const subSel of selection.selectionSet.selections) {
            if (subSel.kind !== 'Field' || subSel.name.value !== 'aggregate') continue;
            if (!subSel.selectionSet) continue;
            for (const aggSel of subSel.selectionSet.selections) {
              if (aggSel.kind !== 'Field' || aggSel.name.value !== 'count') continue;
              const colsArg = getArgumentValue(aggSel, 'columns', variableValues);
              if (Array.isArray(colsArg) && colsArg.length > 0) {
                countColumns = colsArg as string[];
              }
              const distArg = getArgumentValue(aggSel, 'distinct', variableValues);
              if (typeof distArg === 'boolean') {
                countDistinct = distArg;
              }
            }
          }
        }

        const aggRelParsed: AggregateRelationshipParsed = {
          fieldName,
          relationship: aggRel,
          remoteTable,
          hasCount: true, // Always include count
          countColumns,
          countDistinct,
          aggregateFunctions: [],
          where,
          permission: remotePerm ? {
            filter: remotePerm.filter,
            columns: remotePerm.columns,
            limit: remotePerm.limit,
          } : undefined,
        };

        aggregateRelationshipList.push(aggRelParsed);
        continue;
      }

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
          fieldName: getRelFieldName(rel),
          remoteTable,
          columns: subSelection.columns,
          relationships: subSelection.relationships.length > 0
            ? subSelection.relationships
            : undefined,
          jsonbPaths: subSelection.jsonbPaths,
          permission: remotePerm ? {
            filter: remotePerm.filter,
            columns: remotePerm.columns,
            limit: remotePerm.limit,
          } : undefined,
        };

        // For array relationships, parse distinctOn/where/orderBy/limit/offset arguments
        if (rel.type === 'array') {
          const remoteColMap = camelToColumnMap(remoteTable);

          const distinctOnArg = getArgumentValue(selection, 'distinctOn', variableValues);
          if (Array.isArray(distinctOnArg) && distinctOnArg.length > 0) {
            relSelection.distinctOn = distinctOnArg as string[];
          }

          const whereArg = getArgumentValue(selection, 'where', variableValues);
          if (whereArg) {
            relSelection.where = remapBoolExp(whereArg as BoolExp, remoteColMap);
          }

          const orderByArg = getArgumentValue(selection, 'orderBy', variableValues);
          if (orderByArg) {
            relSelection.orderBy = remapOrderBy(
              orderByArg as Array<Record<string, unknown>>,
              remoteColMap,
              remoteTable,
              allTables,
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

          // Check for path argument on JSONB/JSON columns
          if (jsonbColumnCamelNames.has(fieldName)) {
            const pathArg = getArgumentValue(selection, 'path', variableValues);
            if (typeof pathArg === 'string' && pathArg.length > 0) {
              jsonbPaths.set(pgName, pathArg);
            }
          }
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
          functions,
        );
        for (const col of fragmentResult.columns) {
          columnSet.add(col);
        }
        relationships.push(...fragmentResult.relationships);
        if (fragmentResult.computedFields) {
          for (const cf of fragmentResult.computedFields) {
            computedFieldSet.add(cf);
          }
        }
        if (fragmentResult.setReturningComputedFields) {
          setReturningComputedFieldList.push(...fragmentResult.setReturningComputedFields);
        }
        if (fragmentResult.aggregateRelationships) {
          aggregateRelationshipList.push(...fragmentResult.aggregateRelationships);
        }
        if (fragmentResult.jsonbPaths) {
          for (const [col, path] of fragmentResult.jsonbPaths) {
            jsonbPaths.set(col, path);
          }
        }
        if (fragmentResult.computedFieldArgs) {
          for (const [cfName, cfArgs] of fragmentResult.computedFieldArgs) {
            computedFieldArgsMap.set(cfName, cfArgs);
          }
        }
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
        functions,
      );
      for (const col of fragmentResult.columns) {
        columnSet.add(col);
      }
      relationships.push(...fragmentResult.relationships);
      if (fragmentResult.computedFields) {
        for (const cf of fragmentResult.computedFields) {
          computedFieldSet.add(cf);
        }
      }
      if (fragmentResult.setReturningComputedFields) {
        setReturningComputedFieldList.push(...fragmentResult.setReturningComputedFields);
      }
      if (fragmentResult.aggregateRelationships) {
        aggregateRelationshipList.push(...fragmentResult.aggregateRelationships);
      }
      if (fragmentResult.jsonbPaths) {
        for (const [col, path] of fragmentResult.jsonbPaths) {
          jsonbPaths.set(col, path);
        }
      }
      if (fragmentResult.computedFieldArgs) {
        for (const [cfName, cfArgs] of fragmentResult.computedFieldArgs) {
          computedFieldArgsMap.set(cfName, cfArgs);
        }
      }
    }
  }

  // Always include primary key columns — they're needed for identity and relationships
  for (const pkCol of table.primaryKey) {
    columnSet.add(pkCol);
  }

  return {
    columns: Array.from(columnSet),
    relationships,
    computedFields: computedFieldSet.size > 0 ? Array.from(computedFieldSet) : undefined,
    setReturningComputedFields: setReturningComputedFieldList.length > 0 ? setReturningComputedFieldList : undefined,
    aggregateRelationships: aggregateRelationshipList.length > 0 ? aggregateRelationshipList : undefined,
    jsonbPaths: jsonbPaths.size > 0 ? jsonbPaths : undefined,
    computedFieldArgs: computedFieldArgsMap.size > 0 ? computedFieldArgsMap : undefined,
  };
}

/**
 * Parse the "returning" sub-selection from a mutation response's resolve info.
 *
 * Bulk mutations (insert, update, delete) return a MutationResponse with shape:
 *   insertUsers { affectedRows returning { id name articles { ... } } }
 *
 * This function finds the "returning" field and parses its sub-selections
 * to detect relationship fields, enabling nested relationship data in mutation
 * responses.
 */
export function parseReturningInfo(
  info: GraphQLResolveInfo,
  table: TableInfo,
  allTables: TableInfo[],
  permissionLookup: ResolverPermissionLookup,
  session: SessionVariables,
  functions?: FunctionInfo[],
): ParsedSelection | null {
  const fieldNode = info.fieldNodes[0];
  if (!fieldNode.selectionSet) return null;

  const variableValues = info.variableValues as Record<string, unknown>;

  // Find the "returning" field in the mutation response selection
  for (const selection of fieldNode.selectionSet.selections) {
    if (selection.kind === 'Field' && selection.name.value === 'returning') {
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
        functions,
      );
    }
  }

  return null;
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
  functions?: FunctionInfo[],
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
        functions,
      );
    }
  }

  return null;
}

/**
 * Extract `columns` and `distinct` arguments from the `count` field
 * inside `aggregate { count(columns: ..., distinct: ...) }`.
 */
export function parseAggregateCountArgs(
  info: GraphQLResolveInfo,
): { columns?: string[]; distinct?: boolean } {
  const fieldNode = info.fieldNodes[0];
  if (!fieldNode.selectionSet) return {};

  const variableValues = info.variableValues as Record<string, unknown>;

  // Find the "aggregate" field
  for (const sel of fieldNode.selectionSet.selections) {
    if (sel.kind !== 'Field' || sel.name.value !== 'aggregate') continue;
    if (!sel.selectionSet) continue;

    // Find the "count" field inside aggregate
    for (const aggSel of sel.selectionSet.selections) {
      if (aggSel.kind !== 'Field' || aggSel.name.value !== 'count') continue;

      const result: { columns?: string[]; distinct?: boolean } = {};

      const columnsArg = getArgumentValue(aggSel, 'columns', variableValues);
      if (Array.isArray(columnsArg) && columnsArg.length > 0) {
        result.columns = columnsArg as string[];
      }

      const distinctArg = getArgumentValue(aggSel, 'distinct', variableValues);
      if (typeof distinctArg === 'boolean') {
        result.distinct = distinctArg;
      }

      return result;
    }
  }

  return {};
}
