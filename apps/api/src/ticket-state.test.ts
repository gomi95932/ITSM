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

test('new waits require a structured reason matching the wait type and an absolute follow-up time',()=>{
  const input={expectedVersion:2,comment:'Need further action',dueAt:'2026-12-01T10:00:00.000Z'};
  assert.equal(transition('IN_PROGRESS','agent',{...input,action:'REQUEST_INFO',waitingReason:'USER_INFORMATION'}),'WAITING_USER');
  assert.equal(transition('IN_PROGRESS','agent',{...input,action:'WAIT_VENDOR',waitingReason:'VENDOR_SUPPORT',vendorReference:'EXT-1',vendorOwner:'Internal contact'}),'WAITING_VENDOR');
  assert.throws(()=>transition('IN_PROGRESS','agent',{...input,action:'REQUEST_INFO',waitingReason:'VENDOR_SUPPORT'}));
  assert.throws(()=>transition('IN_PROGRESS','agent',{...input,action:'REQUEST_INFO'}));
  assert.throws(()=>transition('IN_PROGRESS','agent',{...input,action:'WAIT_VENDOR',waitingReason:'VENDOR_PARTS',vendorReference:'EXT-1',vendorOwner:'Internal contact',dueAt:undefined}));
  assert.throws(()=>transition('IN_PROGRESS','agent',{...input,action:'WAIT_VENDOR',waitingReason:'USER_AVAILABILITY',vendorReference:'EXT-1',vendorOwner:'Internal contact'}));
  assert.throws(()=>transition('QUEUED','agent',{...input,action:'ACCEPT',waitingReason:'USER_INFORMATION'}));
});

test('vendor resume requires an explanation and only leaves vendor waiting for processing',()=>{
  const input={action:'RESUME_VENDOR',expectedVersion:3,comment:'Replacement received; verifying the service'} as const;
  for(const type of ['INC','REQ'])
    assert.equal(transition('WAITING_VENDOR','agent',input,type),'IN_PROGRESS');
  for(const comment of [undefined,'','   '])
    assert.throws(()=>transition('WAITING_VENDOR','agent',{...input,comment}),
      error=>(error as {getResponse:()=>{code:string}}).getResponse().code==='VENDOR_RESUME_COMMENT_REQUIRED');
  assert.throws(()=>transition('WAITING_VENDOR','requester',input));
  for(const status of ['NEW','QUEUED','IN_PROGRESS','WAITING_USER','WAITING_APPROVAL','PENDING_CONFIRMATION','CLOSED','CANCELLED','REJECTED'] as const)
    assert.throws(()=>transition(status,'agent',input));
  assert.throws(()=>transition('WAITING_VENDOR','agent',{...input,waitingReason:'VENDOR_PARTS'}),
    error=>(error as {getResponse:()=>{code:string}}).getResponse().code==='INVALID_WAITING_REASON');
});
