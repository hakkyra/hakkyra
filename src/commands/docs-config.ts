/**
 * docs-config command — outputs configuration reference documentation.
 *
 * Usage:
 *   hakkyra docs-config                  Output Markdown to stdout (default)
 *   hakkyra docs-config --format json    Output JSON to stdout
 */

import {
  generateConfigDocs,
  renderConfigDocsMarkdown,
  renderConfigDocsJson,
} from '../docs/config-docs.js';

export interface DocsConfigOptions {
  format: 'markdown' | 'json';
}

export function docsConfig(options: DocsConfigOptions): void {
  const docs = generateConfigDocs();

  if (options.format === 'json') {
    process.stdout.write(renderConfigDocsJson(docs));
  } else {
    process.stdout.write(renderConfigDocsMarkdown(docs));
  }
}
