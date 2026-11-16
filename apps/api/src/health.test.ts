import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthController } from './health.controller.js';
import type { Database } from './database.service.js';

test('API health response identifies the service', () => {
  assert.deepEqual(new HealthController({} as Database).check(), { status: 'ok', service: 'itsm-api' });
});

test('readiness checks the database and required schema without returning errors or credentials',async () => {
  const ready=new HealthController({pool:{query:async (sql: string) => {
    assert.match(sql, /015_routing_config_review\.sql/);
    return {rows:[{migrations:'15'}]};
  }}} as unknown as Database);
  assert.deepEqual(await ready.ready(),{status:'ok',service:'itsm-api'});
  const broken=new HealthController({pool:{query:async () => { throw new Error('private database failure'); }}} as unknown as Database);
  await assert.rejects(broken.ready(),error => error instanceof Error && !error.message.includes('private'));
  const unmigrated = new HealthController({pool:{query:async () => ({rows:[{migrations:'0'}]})}} as unknown as Database);
  await assert.rejects(unmigrated.ready(), /Service Unavailable/);
  const previousSchema = new HealthController({pool:{query:async () => ({rows:[{migrations:'11'}]})}} as unknown as Database);
  await assert.rejects(previousSchema.ready(), /Service Unavailable/);
  const missingRoutingSchema = new HealthController({pool:{query:async () => ({rows:[{migrations:'14'}]})}} as unknown as Database);
  await assert.rejects(missingRoutingSchema.ready(), /Service Unavailable/);
});
