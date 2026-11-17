import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownershipDenial, type Ownership } from './ticket-ownership.js';
import { transition } from './ticket-state.js';

const queued:Ownership={status:'QUEUED',assignee_id:null,pending_assignee_id:null};
test('an approved unclaimed request can be dispatched without inventing a personal owner',()=>{
  const request:Ownership={...queued,service_type:'REQ',status:'IN_PROGRESS'};
  for(const action of ['REASSIGN','ASSIGN_OFFER'] as const){
    assert.equal(ownershipDenial(request,'a',true,action),undefined);
    assert.equal(ownershipDenial({...request,service_type:'INC'},'a',true,action),'PERSONAL_OWNER_REQUIRED');
    assert.equal(ownershipDenial(request,'a',false,action),'OWNER_GROUP_REQUIRED');
  }
  for(const action of ['RESOLVE','WAIT_VENDOR','REQUEST_INFO'] as const)
    assert.equal(ownershipDenial(request,'a',true,action),'PERSONAL_OWNER_REQUIRED');
  for(const service_type of ['INC','REQ'])
    assert.equal(ownershipDenial({...request,service_type,assignee_id:'a'},'a',true,'ASSIGN_OFFER'),'TICKET_ALREADY_ASSIGNED');
});
test('only an unassigned group ticket can be claimed; a peer cannot act for its owner',()=>{
  assert.equal(ownershipDenial(queued,'a',true,'ACCEPT'),undefined);
  assert.equal(ownershipDenial(queued,'a',false,'ACCEPT'),'OWNER_GROUP_REQUIRED');
  const owned:Ownership={...queued,status:'IN_PROGRESS',assignee_id:'a'};
  assert.equal(ownershipDenial(owned,'b',true,'ACCEPT'),'TICKET_ALREADY_ASSIGNED');
  for(const action of ['REASSIGN','REQUEST_INFO','WAIT_VENDOR','RESOLVE'] as const)
    assert.equal(ownershipDenial(owned,'b',true,action),'PERSONAL_OWNER_REQUIRED');
  assert.equal(ownershipDenial(owned,'a',true,'RESOLVE'),undefined);
});
test('handover is explicit and only its named recipient accepts or declines',()=>{
  const pending:Ownership={...queued,pending_assignee_id:'b',assignment_kind:'HANDOVER'};
  assert.equal(ownershipDenial(pending,'a',true,'ACCEPT'),'HANDOVER_PENDING');
  assert.equal(ownershipDenial(pending,'a',true,'REASSIGN'),'HANDOVER_PENDING');
  assert.equal(ownershipDenial(pending,'a',true,'CANCEL_HANDOVER'),undefined);
  assert.equal(ownershipDenial(pending,'a',true,'ACCEPT_HANDOVER'),'HANDOVER_TARGET_REQUIRED');
  assert.equal(ownershipDenial(pending,'b',false,'ACCEPT_HANDOVER'),undefined);
  assert.equal(ownershipDenial(pending,'b',false,'DECLINE_HANDOVER'),undefined);
  assert.equal(ownershipDenial(queued,'a',true,'CANCEL_HANDOVER'),'HANDOVER_NOT_PENDING');
});
test('candidate offer reserves the unclaimed ticket for one eligible recipient',()=>{
  const offer:Ownership={...queued,pending_assignee_id:'b',assignment_kind:'OFFER'};
  assert.equal(ownershipDenial(offer,'a',true,'ACCEPT'),'HANDOVER_PENDING');
  assert.equal(ownershipDenial(offer,'b',true,'ACCEPT_OFFER'),undefined);
  assert.equal(ownershipDenial(offer,'a',true,'ACCEPT_OFFER'),'HANDOVER_TARGET_REQUIRED');
  assert.equal(ownershipDenial(offer,'a',true,'CANCEL_OFFER'),undefined);
  assert.equal(ownershipDenial(offer,'a',true,'CANCEL_HANDOVER'),'HANDOVER_NOT_PENDING');
  assert.equal(transition('QUEUED','agent',{action:'ASSIGN_OFFER',expectedVersion:1,targetAssigneeId:'b',reason:'Dispatch'}),'QUEUED');
  assert.equal(transition('QUEUED','agent',{action:'ACCEPT_OFFER',expectedVersion:1,comment:'Investigating'}),'IN_PROGRESS');
});
test('recovery claims and handovers preserve the existing workflow, never reopen terminal tickets',()=>{
  for(const status of ['IN_PROGRESS','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION'] as const){
    assert.equal(transition(status,'agent',{action:'ACCEPT',expectedVersion:1,comment:'Taking responsibility'}),status);
    assert.equal(transition(status,'agent',{action:'ACCEPT_HANDOVER',expectedVersion:1,comment:'Received'}),status);
    assert.equal(transition(status,'agent',{action:'DECLINE_HANDOVER',expectedVersion:1,reason:'Wrong team'}),status);
    assert.equal(transition(status,'agent',{action:'REASSIGN',expectedVersion:1,targetGroupId:'g',targetAssigneeId:'b',reason:'Specialist needed'}),status);
  }
  assert.equal(transition('QUEUED','agent',{action:'ACCEPT_HANDOVER',expectedVersion:1,comment:'Received'}),'IN_PROGRESS');
  for(const status of ['CLOSED','CANCELLED','REJECTED'] as const)
    assert.throws(()=>transition(status,'agent',{action:'ACCEPT_HANDOVER',expectedVersion:1,comment:'Received'}));
  assert.throws(()=>transition('QUEUED','agent',{action:'REASSIGN',expectedVersion:1,targetGroupId:'g',reason:'No person'}));
  assert.throws(()=>transition('IN_PROGRESS','agent',{action:'DECLINE_HANDOVER',expectedVersion:1}));
});
