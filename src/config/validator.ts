import type { HakkyraConfig, BoolExp } from '../types.js';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

const VALID_OPERATORS = new Set<string>([
  // GraphQL naming (Hasura-compatible)
  '_eq', '_neq', '_gt', '_lt', '_gte', '_lte',
  '_in', '_nin', '_isNull',
  '_like', '_nlike', '_ilike', '_nilike',
  '_similar', '_nsimilar',
  '_regex', '_nregex', '_iregex', '_niregex',
  '_contains', '_containedIn',
  '_hasKey', '_hasKeysAny', '_hasKeysAll',
  // YAML metadata compat aliases (snake_case)
  '_ne', '_is_null',
  '_contained_in', '_has_key', '_has_keys_any', '_has_keys_all',
]);

const BOOL_OPERATORS = new Set(['_and', '_or', '_not', '_exists']);

const CRON_FIELD_RANGES: [number, number][] = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day of month
  [1, 12],   // month
  [0, 7],    // day of week (0 and 7 = Sunday)
];

/**
 * Validate a loaded HakkyraConfig for structural correctness.
 * Returns errors for problems that would prevent operation,
 * and warnings for issues that may cause unexpected behavior.
 */
export function validateConfig(config: HakkyraConfig): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  validateVersion(config, errors);
  validateServer(config, errors);
  validateDatabases(config, errors);
  validateTables(config, errors, warnings);
  validateActions(config, errors, warnings);
  validateCronTriggers(config, errors, warnings);
  validateREST(config, errors);
  validateCustomQueries(config, errors);
  validateEventLogRetention(config, errors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateVersion(config: HakkyraConfig, errors: ValidationError[]): void {
  if (!config.version || (config.version !== 2 && config.version !== 3)) {
    errors.push({
      path: 'version',
      message: `Unsupported metadata version: ${config.version}. Expected 2 or 3.`,
    });
  }
}

function validateServer(config: HakkyraConfig, errors: ValidationError[]): void {
  if (config.server.port < 0 || config.server.port > 65535) {
    errors.push({
      path: 'server.port',
      message: `Invalid port number: ${config.server.port}. Must be between 0 and 65535.`,
    });
  }
}

function validateDatabases(config: HakkyraConfig, errors: ValidationError[]): void {
  if (!config.databases.primary.urlEnv) {
    errors.push({
      path: 'databases.primary.urlEnv',
      message: 'Primary database URL environment variable is required.',
    });
  }
}

function validateTables(
  config: HakkyraConfig,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  const tableNames = new Set<string>();

  for (let i = 0; i < config.tables.length; i++) {
    const table = config.tables[i];
    const tablePath = `tables[${i}]`;

    if (!table.name) {
      errors.push({ path: `${tablePath}.name`, message: 'Table name is required.' });
      continue;
    }

    if (!table.schema) {
      errors.push({ path: `${tablePath}.schema`, message: 'Table schema is required.' });
    }

    const qualifiedName = `${table.schema}.${table.name}`;
    if (tableNames.has(qualifiedName)) {
      warnings.push({
        path: tablePath,
        message: `Duplicate table definition: ${qualifiedName}.`,
      });
    }
    tableNames.add(qualifiedName);

    validateTablePermissions(table.permissions, `${tablePath}.permissions`, errors);

    for (let j = 0; j < table.eventTriggers.length; j++) {
      const trigger = table.eventTriggers[j];
      const triggerPath = `${tablePath}.eventTriggers[${j}]`;

      if (!trigger.name) {
        errors.push({ path: `${triggerPath}.name`, message: 'Event trigger name is required.' });
      }
      if (!trigger.webhook && !trigger.webhookFromEnv) {
        errors.push({
          path: `${triggerPath}.webhook`,
          message: `Event trigger "${trigger.name}" requires a webhook URL or webhook_from_env.`,
        });
      }
    }

    for (let j = 0; j < table.relationships.length; j++) {
      const rel = table.relationships[j];
      const relPath = `${tablePath}.relationships[${j}]`;

      if (!rel.name) {
        errors.push({ path: `${relPath}.name`, message: 'Relationship name is required.' });
      }
      if (rel.type !== 'object' && rel.type !== 'array') {
        errors.push({
          path: `${relPath}.type`,
          message: `Invalid relationship type: "${rel.type}". Must be "object" or "array".`,
        });
      }
    }
  }
}

function validateTablePermissions(
  permissions: HakkyraConfig['tables'][number]['permissions'],
  basePath: string,
  errors: ValidationError[],
): void {
  for (const [role, perm] of Object.entries(permissions.select)) {
    validateBoolExp(perm.filter, `${basePath}.select.${role}.filter`, errors);
  }
  for (const [role, perm] of Object.entries(permissions.insert)) {
    validateBoolExp(perm.check, `${basePath}.insert.${role}.check`, errors);
  }
  for (const [role, perm] of Object.entries(permissions.update)) {
    validateBoolExp(perm.filter, `${basePath}.update.${role}.filter`, errors);
    if (perm.check) {
      validateBoolExp(perm.check, `${basePath}.update.${role}.check`, errors);
    }
  }
  for (const [role, perm] of Object.entries(permissions.delete)) {
    validateBoolExp(perm.filter, `${basePath}.delete.${role}.filter`, errors);
  }
}

function validateBoolExp(
  exp: BoolExp,
  path: string,
  errors: ValidationError[],
): void {
  if (!exp || typeof exp !== 'object') return;

  for (const key of Object.keys(exp)) {
    if (BOOL_OPERATORS.has(key)) {
      if (key === '_and' || key === '_or') {
        const arr = (exp as Record<string, unknown>)[key];
        if (!Array.isArray(arr)) {
          errors.push({ path: `${path}.${key}`, message: `${key} must be an array.` });
        } else {
          for (let i = 0; i < arr.length; i++) {
            validateBoolExp(arr[i] as BoolExp, `${path}.${key}[${i}]`, errors);
          }
        }
      } else if (key === '_not') {
        validateBoolExp(
          (exp as Record<string, unknown>)[key] as BoolExp,
          `${path}.${key}`,
          errors,
        );
      }
    } else if (key.startsWith('_')) {
      if (!VALID_OPERATORS.has(key)) {
        errors.push({
          path: `${path}.${key}`,
          message: `Unknown operator: "${key}".`,
        });
      }
    } else {
      const value = (exp as Record<string, unknown>)[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const innerKeys = Object.keys(value as object);
        const looksLikeOperators = innerKeys.some((k) => k.startsWith('_'));
        if (looksLikeOperators) {
          for (const op of innerKeys) {
            if (op.startsWith('_') && !VALID_OPERATORS.has(op) && !BOOL_OPERATORS.has(op)) {
              errors.push({
                path: `${path}.${key}.${op}`,
                message: `Unknown column operator: "${op}".`,
              });
            }
          }
        } else {
          validateBoolExp(value as BoolExp, `${path}.${key}`, errors);
        }
      }
    }
  }
}

function validateActions(
  config: HakkyraConfig,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  const actionNames = new Set<string>();

  for (let i = 0; i < config.actions.length; i++) {
    const action = config.actions[i];
    const actionPath = `actions[${i}]`;

    if (!action.name) {
      errors.push({ path: `${actionPath}.name`, message: 'Action name is required.' });
      continue;
    }

    if (actionNames.has(action.name)) {
      warnings.push({
        path: actionPath,
        message: `Duplicate action name: "${action.name}".`,
      });
    }
    actionNames.add(action.name);

    if (!action.definition.handler && !action.definition.handlerFromEnv) {
      errors.push({
        path: `${actionPath}.definition.handler`,
        message: `Action "${action.name}" requires a handler URL or handler_from_env.`,
      });
    }

    if (
      action.definition.kind !== 'synchronous' &&
      action.definition.kind !== 'asynchronous'
    ) {
      errors.push({
        path: `${actionPath}.definition.kind`,
        message: `Action "${action.name}" has invalid kind: "${action.definition.kind}". Must be "synchronous" or "asynchronous".`,
      });
    }
  }
}

function validateCronTriggers(
  config: HakkyraConfig,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  const cronNames = new Set<string>();

  for (let i = 0; i < config.cronTriggers.length; i++) {
    const cron = config.cronTriggers[i];
    const cronPath = `cronTriggers[${i}]`;

    if (!cron.name) {
      errors.push({ path: `${cronPath}.name`, message: 'Cron trigger name is required.' });
      continue;
    }

    if (cronNames.has(cron.name)) {
      warnings.push({
        path: cronPath,
        message: `Duplicate cron trigger name: "${cron.name}".`,
      });
    }
    cronNames.add(cron.name);

    if (!cron.webhook && !cron.webhookFromEnv) {
      errors.push({
        path: `${cronPath}.webhook`,
        message: `Cron trigger "${cron.name}" requires a webhook URL or webhook_from_env.`,
      });
    }

    if (!cron.schedule) {
      errors.push({
        path: `${cronPath}.schedule`,
        message: `Cron trigger "${cron.name}" requires a schedule.`,
      });
    } else {
      const cronError = validateCronExpression(cron.schedule);
      if (cronError) {
        errors.push({
          path: `${cronPath}.schedule`,
          message: `Cron trigger "${cron.name}" has invalid schedule "${cron.schedule}": ${cronError}`,
        });
      }
    }
  }
}

function validateCronExpression(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);

  if (parts.length < 5 || parts.length > 6) {
    return `Expected 5 or 6 fields, got ${parts.length}.`;
  }

  const fieldNames = ['minute', 'hour', 'day of month', 'month', 'day of week'];

  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const error = validateCronField(field, CRON_FIELD_RANGES[i], fieldNames[i]);
    if (error) return error;
  }

  return null;
}

function validateCronField(
  field: string,
  [min, max]: [number, number],
  name: string,
): string | null {
  if (field === '*') return null;

  const alternatives = field.split(',');
  for (const alt of alternatives) {
    const stepParts = alt.split('/');
    if (stepParts.length > 2) {
      return `Invalid ${name} field: "${field}".`;
    }

    const rangePart = stepParts[0];
    const stepPart = stepParts[1];

    if (stepPart !== undefined) {
      const step = parseInt(stepPart, 10);
      if (isNaN(step) || step < 1) {
        return `Invalid step value in ${name} field: "${field}".`;
      }
    }

    if (rangePart === '*') continue;

    const rangeBounds = rangePart.split('-');
    if (rangeBounds.length > 2) {
      return `Invalid range in ${name} field: "${field}".`;
    }

    for (const bound of rangeBounds) {
      const num = parseInt(bound, 10);
      if (isNaN(num)) {
        // Allow month/day-of-week names
        if (name === 'month' || name === 'day of week') continue;
        return `Invalid value in ${name} field: "${bound}".`;
      }
      if (num < min || num > max) {
        return `Value ${num} out of range [${min}-${max}] in ${name} field.`;
      }
    }
  }

  return null;
}

function validateREST(config: HakkyraConfig, errors: ValidationError[]): void {
  if (config.rest.pagination.defaultLimit < 1) {
    errors.push({
      path: 'rest.pagination.defaultLimit',
      message: 'Default pagination limit must be at least 1.',
    });
  }
  if (config.rest.pagination.maxLimit < config.rest.pagination.defaultLimit) {
    errors.push({
      path: 'rest.pagination.maxLimit',
      message: 'Max pagination limit must be >= default limit.',
    });
  }
}

function validateCustomQueries(config: HakkyraConfig, errors: ValidationError[]): void {
  for (let i = 0; i < config.customQueries.length; i++) {
    const query = config.customQueries[i];
    const qPath = `customQueries[${i}]`;

    if (!query.name) {
      errors.push({ path: `${qPath}.name`, message: 'Custom query name is required.' });
    }
    if (!query.sql) {
      errors.push({
        path: `${qPath}.sql`,
        message: `Custom query "${query.name}" requires SQL.`,
      });
    }
    if (!query.returns) {
      errors.push({
        path: `${qPath}.returns`,
        message: `Custom query "${query.name}" requires a return type.`,
      });
    }
    if (query.type !== 'query' && query.type !== 'mutation') {
      errors.push({
        path: `${qPath}.type`,
        message: `Custom query "${query.name}" has invalid type: "${query.type}". Must be "query" or "mutation".`,
      });
    }
  }
}

function validateEventLogRetention(config: HakkyraConfig, errors: ValidationError[]): void {
  if (config.eventLogRetentionDays < 1) {
    errors.push({
      path: 'eventLogRetentionDays',
      message: `Event log retention must be at least 1 day, got ${config.eventLogRetentionDays}.`,
    });
  }
  if (!Number.isInteger(config.eventLogRetentionDays)) {
    errors.push({
      path: 'eventLogRetentionDays',
      message: `Event log retention must be a whole number of days, got ${config.eventLogRetentionDays}.`,
    });
  }
}
