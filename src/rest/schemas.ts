/**
 * Zod schemas for REST API input validation.
 *
 * Covers structural validation of request bodies and pagination parameters.
 * Filter parsing is intentionally NOT wrapped in Zod — it has its own
 * error handling in `filters.ts`.
 */

import { z } from 'zod';

/**
 * Insert/update request body: must be a plain object (not null, not array).
 * The z.record() type already rejects null and arrays, but the refine
 * provides a friendlier error message for edge cases.
 */
export const MutationBodySchema = z.record(z.string(), z.unknown()).refine(
  (val) => val !== null && !Array.isArray(val),
  { message: 'Request body must be a JSON object' },
);

/**
 * Pagination query parameters: limit and offset must be non-negative integers.
 */
export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(0).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
