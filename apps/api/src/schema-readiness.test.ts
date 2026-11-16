import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { matchesSchemaMigrations, readSchemaMigrations } from './schema-readiness.js';

test('schema manifest follows added SQL files without a source enum or hard-coded migration count', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'itsm-schema-manifest-'));
  try {
    await assert.rejects(readSchemaMigrations(directory), /SCHEMA_MANIFEST_EMPTY/);
    await assert.rejects(readSchemaMigrations(resolve(directory, 'missing')));
    const sql = 'CREATE TABLE manifest_fixture(id integer);\n';
    await writeFile(resolve(directory, '001_fixture.sql'), sql);
    await writeFile(resolve(directory, 'README.md'), 'not a migration');
    await mkdir(resolve(directory, 'nested'));
    const first = await readSchemaMigrations(directory);
    assert.deepEqual(first, [{name:'001_fixture.sql', checksum:createHash('sha256').update(sql).digest('hex')}]);
    await writeFile(resolve(directory, '021_future.sql'), 'SELECT 1;\n');
    const next = await readSchemaMigrations(directory);
    assert.deepEqual(next.map(row => row.name), ['001_fixture.sql', '021_future.sql']);
    assert.equal(matchesSchemaMigrations(next, first), false);
    assert.equal(matchesSchemaMigrations(next, next), true);
    assert.equal(matchesSchemaMigrations([], []), false);
  } finally { await rm(directory, {recursive:true, force:true}); }
});
