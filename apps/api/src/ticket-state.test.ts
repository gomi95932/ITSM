import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transition } from './ticket-state.js';

test('agent and requester can complete and reopen only before closure', () => {
  assert.equal(transition('QUEUED', 'agent', { action: 'ACCEPT', expectedVersion: 1,comment:'正在排查，请稍候' }), 'IN_PROGRESS');
  assert.equal(transition('IN_PROGRESS', 'agent', { action: 'RESOLVE', expectedVersion: 2, comment: 'Restored', resolutionCategory: 'FIX', evidence: 'Verified' }), 'PENDING_CONFIRMATION');
  assert.equal(transition('PENDING_CONFIRMATION', 'requester', { action: 'REOPEN', expectedVersion: 3, reason: 'Still fails' }), 'IN_PROGRESS');
  assert.equal(transition('PENDING_CONFIRMATION', 'requester', { action: 'CONFIRM', expectedVersion: 3 }), 'CLOSED');
  assert.throws(() => transition('CLOSED', 'requester', { action: 'REOPEN', expectedVersion: 4 }));
});

test('permission, prerequisites, and illegal transitions are denied', () => {
  assert.throws(() => transition('QUEUED', 'agent', { action: 'ACCEPT', expectedVersion: 1 }));
  assert.throws(() => transition('QUEUED', 'requester', { action: 'ACCEPT', expectedVersion: 1 }));
  assert.throws(() => transition('IN_PROGRESS', 'agent', { action: 'REQUEST_INFO', expectedVersion: 2 }));
  assert.throws(() => transition('CANCELLED', 'agent', { action: 'RESOLVE', expectedVersion: 2 }));
  assert.throws(() => transition('WAITING_USER', 'requester', { action: 'ADD_INFO', expectedVersion: 2 }));
  assert.equal(transition('WAITING_USER', 'requester', { action: 'ADD_INFO', expectedVersion: 2, comment: 'Details provided' }), 'IN_PROGRESS');
});
