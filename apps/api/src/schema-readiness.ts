import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export type SchemaMigration = Readonly<{ name: string; checksum: string }>;

// Resolve from the compiled API, not the process working directory. The API
// and migration runner use the same SQL files already included in the image.
export async function readSchemaMigrations(directory = resolve(__dirname, '../../../db/migrations')): Promise<SchemaMigration[]> {
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('SCHEMA_MANIFEST_EMPTY');
  return Promise.all(names.map(async name => ({
    name,
    checksum: createHash('sha256').update(await readFile(resolve(directory, name), 'utf8')).digest('hex'),
  })));
}

export function matchesSchemaMigrations(expected: readonly SchemaMigration[], applied: readonly SchemaMigration[]): boolean {
  if (!expected.length || expected.length !== applied.length) return false;
  const ledger = new Map(applied.map(row => [row.name, row.checksum]));
  return ledger.size === applied.length && expected.every(row => ledger.get(row.name) === row.checksum);
}
