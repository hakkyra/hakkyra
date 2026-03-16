/**
 * Async action handler.
 *
 * Provides the core lifecycle for asynchronous actions:
 * 1. Enqueue: insert a row, enqueue a job, return action ID immediately
 * 2. Worker: process the job by calling the webhook, store the result
 * 3. Query: retrieve the current status and result of an async action
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { ActionConfig, SessionVariables, AsyncActionResult } from '../types.js';
import type { JobQueue, Job } from '../shared/job-queue/types.js';
import { executeAction } from './proxy.js';
import {
  nsKey,
  WELL_KNOWN_SUFFIXES,
  DEFAULT_SESSION_NAMESPACE,
  resolveSessionVar,
} from '../auth/session-namespace.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface AsyncActionRow {
  id: string;
  action_name: string;
  input: Record<string, unknown>;
  session_variables: Record<string, string> | null;
  status: string;
  output: unknown;
  errors: unknown;
  created_at: string;
  updated_at: string;
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

/**
 * Enqueue an async action: insert a row into the async_action_log
 * and enqueue a job for the worker to process.
 *
 * @returns The action ID (UUID) that the client can use to poll for results.
 */
export async function enqueueAsyncAction(
  jobQueue: JobQueue,
  pool: Pool,
  action: ActionConfig,
  input: Record<string, unknown>,
  session: SessionVariables,
): Promise<string> {
  // Build session variables map (Hasura format) for storage
  const sessionVariables: Record<string, string> = {};
  for (const [key, value] of Object.entries(session.claims)) {
    sessionVariables[key] = Array.isArray(value) ? value.join(',') : value;
  }
  if (session.role) {
    sessionVariables[nsKey(DEFAULT_SESSION_NAMESPACE, WELL_KNOWN_SUFFIXES.ROLE)] = session.role;
    if (DEFAULT_SESSION_NAMESPACE !== 'x-hasura') {
      sessionVariables['x-hasura-role'] = session.role;
    }
  }

  // Insert row into async_action_log
  const result = await pool.query<{ id: string }>(
    `INSERT INTO hakkyra.async_action_log
     (action_name, input, session_variables, status)
     VALUES ($1, $2, $3, 'created')
     RETURNING id`,
    [action.name, JSON.stringify(input), JSON.stringify(sessionVariables)],
  );

  const actionId = result.rows[0].id;

  // Enqueue job via the job queue
  await jobQueue.send(`action/${action.name}`, {
    actionId,
    actionName: action.name,
  });

  // Update status to 'processing'
  await pool.query(
    `UPDATE hakkyra.async_action_log SET status = 'processing', updated_at = now() WHERE id = $1`,
    [actionId],
  );

  return actionId;
}

// ─── Worker Registration ────────────────────────────────────────────────────

/**
 * Register job queue workers for all async actions.
 *
 * Each worker fetches the action from the DB, calls the webhook handler,
 * and stores the result.
 */
export async function registerAsyncActionWorkers(
  jobQueue: JobQueue,
  pool: Pool,
  actions: ActionConfig[],
  logger: Logger,
): Promise<void> {
  const asyncActions = actions.filter((a) => a.definition.kind === 'asynchronous');

  if (asyncActions.length === 0) return;

  // Build action config lookup
  const actionConfigMap = new Map<string, ActionConfig>();
  for (const action of asyncActions) {
    actionConfigMap.set(action.name, action);
  }

  for (const action of asyncActions) {
    const queueName = `action/${action.name}`;

    // Configure the queue with retry settings
    await jobQueue.createQueue(queueName, {
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
      expireInSeconds: action.definition.timeout ?? 120,
    });

    await jobQueue.work<{ actionId: string; actionName: string }>(
      queueName,
      async (jobs: Job<{ actionId: string; actionName: string }>[]) => {
        for (const job of jobs) {
          const { actionId } = job.data;

          // Fetch the action row from DB
          const rowResult = await pool.query<AsyncActionRow>(
            `SELECT id, action_name, input, session_variables, status
             FROM hakkyra.async_action_log
             WHERE id = $1`,
            [actionId],
          );

          const row = rowResult.rows[0];
          if (!row) {
            logger.warn({ actionId }, 'Async action row not found, skipping');
            continue;
          }

          const actionConfig = actionConfigMap.get(row.action_name);
          if (!actionConfig) {
            logger.warn({ actionId, actionName: row.action_name }, 'Action config not found');
            await pool.query(
              `UPDATE hakkyra.async_action_log
               SET status = 'failed', errors = $2, updated_at = now()
               WHERE id = $1`,
              [actionId, JSON.stringify({ message: `Action config "${row.action_name}" not found` })],
            );
            continue;
          }

          // Reconstruct session from stored session variables
          const sessionVars = row.session_variables ?? {};
          const ns = DEFAULT_SESSION_NAMESPACE;
          const roleKey = nsKey(ns, WELL_KNOWN_SUFFIXES.ROLE);
          const userIdKey = nsKey(ns, WELL_KNOWN_SUFFIXES.USER_ID);
          const allowedRolesKey = nsKey(ns, WELL_KNOWN_SUFFIXES.ALLOWED_ROLES);
          const session: SessionVariables = {
            role: sessionVars[roleKey] ?? sessionVars['x-hasura-role'] ?? 'anonymous',
            userId: sessionVars[userIdKey] ?? sessionVars['x-hasura-user-id'],
            allowedRoles: (sessionVars[allowedRolesKey] ?? sessionVars['x-hasura-allowed-roles'])
              ? (sessionVars[allowedRolesKey] ?? sessionVars['x-hasura-allowed-roles']).split(',')
              : [],
            isAdmin: false,
            claims: sessionVars,
          };

          logger.info(
            { actionId, actionName: row.action_name, jobId: job.id },
            'Processing async action',
          );

          // Execute the webhook
          const result = await executeAction({
            action: actionConfig,
            input: row.input,
            session,
          });

          if (result.success) {
            // Store successful result
            await pool.query(
              `UPDATE hakkyra.async_action_log
               SET status = 'completed', output = $2, updated_at = now()
               WHERE id = $1`,
              [actionId, JSON.stringify(result.data)],
            );

            logger.info(
              { actionId, actionName: row.action_name },
              'Async action completed',
            );
          } else {
            // Store failure
            await pool.query(
              `UPDATE hakkyra.async_action_log
               SET status = 'failed', errors = $2, updated_at = now()
               WHERE id = $1`,
              [actionId, JSON.stringify({ message: result.error, extensions: result.extensions })],
            );

            logger.warn(
              { actionId, actionName: row.action_name, error: result.error },
              'Async action failed',
            );

            // Throw so the job queue retries
            throw new Error(`Async action webhook failed: ${result.error}`);
          }
        }
      },
    );
  }

  logger.info(
    { count: asyncActions.length, actions: asyncActions.map((a) => a.name) },
    'Async action workers registered',
  );
}

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Get the current result/status of an async action by ID.
 */
export async function getAsyncActionResult(
  pool: Pool,
  actionId: string,
): Promise<AsyncActionResult | null> {
  const result = await pool.query<AsyncActionRow>(
    `SELECT id, action_name, status, output, errors, created_at, updated_at
     FROM hakkyra.async_action_log
     WHERE id = $1`,
    [actionId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    actionName: row.action_name,
    status: row.status as AsyncActionResult['status'],
    output: row.output ?? undefined,
    errors: row.errors ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
