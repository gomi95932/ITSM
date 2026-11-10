import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const directory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const files = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
if (!files.length) throw new Error('NO_MIGRATIONS');
const migrations = await Promise.all(files.map(async name => {
  const sql = await readFile(`${directory}/${name}`, 'utf8');
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) throw new Error('MIGRATION_TRANSACTION_MUST_BE_RUNNER_OWNED');
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}));
if (process.env.ITSM_SEED_DEV_DATA === 'true' && process.env.NODE_ENV === 'production')
  throw new Error('PRODUCTION_SEED_FORBIDDEN');
const client = new pg.Client({
  host: process.env.DB_HOST ?? 'db', port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'itsm', user: process.env.DB_USER ?? 'itsm', password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 5000, statement_timeout: 60000,
});
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query('SELECT pg_advisory_xact_lock(482019, 1)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = (await client.query('SELECT name,checksum FROM schema_migrations')).rows;
  for (const row of applied) {
    const migration = migrations.find(item => item.name === row.name);
    if (!migration) throw new Error('DATABASE_SCHEMA_NEWER_THAN_RELEASE');
    if (migration.checksum !== row.checksum) throw new Error('APPLIED_MIGRATION_CHANGED');
  }
  for (const migration of migrations) {
    if (applied.some(row => row.name === migration.name)) continue;
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [migration.name, migration.checksum]);
    console.log(`Applied ${migration.name}`);
  }
  await client.query('COMMIT');
  if (process.env.ITSM_SEED_DEV_DATA === 'true') {
    await client.query(await readFile(new URL('../db/seeds/dev.sql', import.meta.url), 'utf8'));
    console.log('Explicit development fixtures loaded');
  }
  console.log(`Migration check complete: ${migrations.length} immutable migrations`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  const safe = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'MIGRATION_FAILED';
  console.error(safe);
  process.exitCode = 1;
} finally { await client.end(); }
