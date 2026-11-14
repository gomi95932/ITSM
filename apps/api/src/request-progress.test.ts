import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canViewRequestProgress } from './tickets.service.js';

test('request progress is only visible to the requester of a REQ ticket', () => {
  assert.equal(canViewRequestProgress('employee-1', 'employee-1', 'REQ'), true);
  assert.equal(canViewRequestProgress('support-agent', 'employee-1', 'REQ'), false);
  assert.equal(canViewRequestProgress('employee-1', 'employee-1', 'INC'), false);
});
