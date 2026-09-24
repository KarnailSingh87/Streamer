#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const schemaPath = resolve(rootDir, 'schema.sql');

if (!existsSync(schemaPath)) {
  console.error(`[db:init] schema.sql not found at ${schemaPath}`);
  process.exit(1);
}

const schemaSql = readFileSync(schemaPath, 'utf8');

let url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  const rawPath = process.env.DB_PATH || 'streamer.db';
  const resolvedPath = rawPath.startsWith('file:') ? rawPath.slice(5) : rawPath;
  const absPath = resolve(rootDir, resolvedPath);
  url = `file:${absPath}`;
}

console.log(`[db:init] Initializing database at ${url.startsWith('libsql:') ? 'Turso remote URL' : url}...`);

const client = createClient({ url, authToken });

try {
  await client.executeMultiple(schemaSql);
  console.log('[db:init] Schema applied successfully. Database is ready.');
} catch (err) {
  console.error('[db:init] Failed to apply schema:', err);
  process.exit(1);
}
