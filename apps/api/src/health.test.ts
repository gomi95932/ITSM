import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthController } from './health.controller.js';

test('API health response identifies the service', () => {
  assert.deepEqual(new HealthController().check(), { status: 'ok', service: 'itsm-api' });
});
