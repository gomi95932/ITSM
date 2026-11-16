import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import type { Database } from './database.service.js';
import { readSchemaMigrations, type SchemaMigration } from './schema-readiness.js';

test('API health response identifies the service without requiring database readiness', () => {
  assert.deepEqual(new HealthController({} as Database).check(), { status: 'ok', service: 'itsm-api' });
});

const controller = (rows: SchemaMigration[]) => new HealthController({pool:{query:async (sql: string) => {
  assert.match(sql, /FROM schema_migrations/);
  assert.match(sql, /FROM tickets/);
  assert.match(sql, /FROM sla_cycles/);
  return {rows};
}}} as unknown as Database);

test('readiness requires all SQL files shipped in the image, with their exact checksums', async () => {
  const migrations = await readSchemaMigrations();
  assert.ok(migrations.some(row => row.name === '019_support_group_lifecycle.sql'));
  assert.ok(migrations.some(row => row.name === '020_ticket_continuity.sql'));
  assert.deepEqual(await controller(migrations).ready(), {status:'ok', service:'itsm-api'});
  assert.deepEqual(await controller([...migrations].reverse()).ready(), {status:'ok', service:'itsm-api'});
  for (let index = 0; index < migrations.length; index++) {
    const missing = migrations.filter((_, i) => i !== index);
    await assert.rejects(controller(missing).ready(), /Service Unavailable/);
    const changed = migrations.map((row, i) => i === index ? {...row, checksum:'0'.repeat(64)} : row);
    await assert.rejects(controller(changed).ready(), /Service Unavailable/);
  }
  await assert.rejects(controller([]).ready(), /Service Unavailable/);
  await assert.rejects(controller([...migrations, {name:'999_future.sql', checksum:'f'.repeat(64)}]).ready(), /Service Unavailable/);
  await assert.rejects(controller([...migrations.slice(1), {name:'999_future.sql', checksum:migrations[0].checksum}]).ready(), /Service Unavailable/);
  await assert.rejects(controller([...migrations.slice(1), migrations[1]]).ready(), /Service Unavailable/);
});

test('readiness rechecks the database on each call and never returns internal failures', async () => {
  const migrations = await readSchemaMigrations();
  let rows = migrations;
  const ready = new HealthController({pool:{query:async () => ({rows})}} as unknown as Database);
  await ready.ready();
  rows = migrations.slice(0, -1);
  await assert.rejects(ready.ready(), /Service Unavailable/);
  rows = migrations;
  await ready.ready();
  const broken = new HealthController({pool:{query:async () => { throw new Error('private database failure'); }}} as unknown as Database);
  await assert.rejects(broken.ready(), error => {
    assert.ok(error instanceof ServiceUnavailableException && !error.message.includes('private'));
    assert.deepEqual(error.getResponse(), {code:'API_NOT_READY'});
    return true;
  });
});
