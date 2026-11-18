import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transition } from './ticket-state.js';

test('only the requester may cancel a request awaiting approval', () => {
  const cancel = {action:'CANCEL',expectedVersion:1} as const;
  assert.equal(transition('WAITING_APPROVAL','requester',cancel,'REQ'),'CANCELLED');
  assert.throws(()=>transition('WAITING_APPROVAL','requester',cancel,'INC'));
  assert.throws(()=>transition('WAITING_APPROVAL','agent',cancel,'REQ'));
  assert.throws(()=>transition('IN_PROGRESS','requester',cancel,'REQ'));
});

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

test('continuity decisions and supervisor initiation never restart a workflow or reopen closed tickets',()=>{
  for(const status of ['QUEUED','IN_PROGRESS','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION'] as const){
    assert.equal(transition(status,'agent',{action:'INITIATE_HANDOVER',expectedVersion:1,targetGroupId:'g',targetAssigneeId:'b',reason:'Supervised handover'}),status);
    for(const action of ['CONTINUATION_PROPOSE','CONTINUATION_APPROVE','CONTINUATION_REJECT','CONTINUATION_REVOKE'] as const)
      assert.equal(transition(status,'agent',{action,expectedVersion:1,reason:'Reviewed continuity'}),status);
  }
  assert.throws(()=>transition('CLOSED','agent',{action:'CONTINUATION_APPROVE',expectedVersion:1,reason:'Cannot reopen'}));
  assert.throws(()=>transition('IN_PROGRESS','agent',{action:'CONTINUATION_PROPOSE',expectedVersion:1}));
  assert.throws(()=>transition('IN_PROGRESS','requester',{action:'CONTINUATION_PROPOSE',expectedVersion:1,reason:'Not authorized'}));
});
