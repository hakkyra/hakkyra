/**
 * SQL building utilities: identifier quoting and parameter tracking.
 */

// ─── Identifier Quoting ──────────────────────────────────────────────────────

/**
 * Safely quote a SQL identifier with double quotes.
 * Escapes any embedded double quotes by doubling them.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a fully-qualified table reference: "schema"."table"
 */
export function quoteTableRef(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

// ─── Parameter Collector ─────────────────────────────────────────────────────

/**
 * Tracks parameterized query values ($1, $2, ...) and collects their values.
 * Ensures user input is never interpolated into SQL strings.
 */
export class ParamCollector {
  private params: unknown[] = [];
  private offset: number;

  constructor(initialOffset = 0) {
    this.offset = initialOffset;
  }

  /**
   * Add a single parameter value.
   * Returns the `$N` placeholder string for use in the SQL query.
   */
  add(value: unknown): string {
    this.params.push(value);
    return `$${this.offset + this.params.length}`;
  }

  /**
   * Add multiple parameter values for use in IN clauses.
   * Returns a parenthesized comma-separated list of placeholders: `($N, $N+1, ...)`.
   * Returns `(NULL)` for empty arrays to produce a valid SQL expression that matches nothing.
   */
  addMany(values: unknown[]): string {
    if (values.length === 0) {
      // IN (NULL) never matches anything — safe fallback for empty arrays
      return '(NULL)';
    }
    const placeholders = values.map((v) => this.add(v));
    return `(${placeholders.join(', ')})`;
  }

  /** Returns all collected parameter values in order. */
  getParams(): unknown[] {
    return this.params;
  }

  /** Returns the current total parameter count (including initial offset). */
  getOffset(): number {
    return this.offset + this.params.length;
  }
}
