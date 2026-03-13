/**
 * Init command — scaffolds a new Hakkyra project.
 *
 * Creates:
 *   hakkyra.yaml                                — server config
 *   metadata/version.yaml                       — { version: 3 }
 *   metadata/databases/databases.yaml           — database config template
 *   metadata/databases/default/tables/tables.yaml — empty tables index
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface InitOptions {
  force: boolean;
}

const HAKKYRA_YAML = `# Hakkyra server configuration
# See https://github.com/nickthecook/hakkyra for full docs

server:
  port: 3000
  host: 0.0.0.0

# Database connection
# Set HAKKYRA_DATABASE_URL env var or configure below
databases:
  default:
    connection_url_env: HAKKYRA_DATABASE_URL

# REST API settings
rest:
  base_path: /api/v1

# Auth (disabled by default)
# auth:
#   jwt:
#     secret_env: HAKKYRA_JWT_SECRET
#     claims_namespace: https://hasura.io/jwt/claims
`;

const VERSION_YAML = `version: 3
`;

const DATABASES_YAML = `- name: default
  kind: postgres
  configuration:
    connection_info:
      database_url:
        from_env: HAKKYRA_DATABASE_URL
  tables: "!include default/tables/tables.yaml"
`;

const TABLES_YAML = `# Tracked tables
# Add your tables here, for example:
#
# - table:
#     schema: public
#     name: users
#   select_permissions:
#     - role: user
#       permission:
#         columns: "*"
#         filter:
#           id:
#             _eq: X-Hasura-User-Id
[]
`;

interface FileToCreate {
  relativePath: string;
  content: string;
}

const FILES: FileToCreate[] = [
  { relativePath: 'hakkyra.yaml', content: HAKKYRA_YAML },
  { relativePath: 'metadata/version.yaml', content: VERSION_YAML },
  { relativePath: 'metadata/databases/databases.yaml', content: DATABASES_YAML },
  { relativePath: 'metadata/databases/default/tables/tables.yaml', content: TABLES_YAML },
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function initProject(options: InitOptions): Promise<void> {
  const cwd = process.cwd();

  console.log('');
  console.log('  Hakkyra init — scaffolding project...');
  console.log('');

  // Check for existing files (unless --force)
  if (!options.force) {
    const existing: string[] = [];
    for (const file of FILES) {
      const fullPath = path.join(cwd, file.relativePath);
      if (await fileExists(fullPath)) {
        existing.push(file.relativePath);
      }
    }

    if (existing.length > 0) {
      console.error('  The following files already exist:');
      for (const f of existing) {
        console.error(`    - ${f}`);
      }
      console.error('');
      console.error('  Use --force to overwrite existing files.');
      process.exit(1);
    }
  }

  // Create files
  for (const file of FILES) {
    const fullPath = path.join(cwd, file.relativePath);
    const dir = path.dirname(fullPath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf-8');

    console.log(`  Created ${file.relativePath}`);
  }

  console.log('');
  console.log('  Project scaffolded successfully.');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Set HAKKYRA_DATABASE_URL to your PostgreSQL connection string');
  console.log('    2. Add tables to metadata/databases/default/tables/tables.yaml');
  console.log('    3. Run: hakkyra start');
  console.log('');
}
