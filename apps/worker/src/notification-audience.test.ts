import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationAudience } from './notification-audience.js';

test('continuity and supervisor handover notify named owner and escalation without leaking to requester',()=>{
  for(const action of ['CONTINUATION_PROPOSE','CONTINUATION_APPROVE','CONTINUATION_REJECT','CONTINUATION_REVOKE','INITIATE_HANDOVER']){
    assert.equal(notificationAudience(action).owner,true);
    assert.equal(notificationAudience(action).escalation,true);
    assert.equal(notificationAudience(action).requester,undefined);
  }
  assert.equal(notificationAudience('INITIATE_HANDOVER').pending,true);
});

test('only named public progress events include the requester', () => {
  for (const action of ['SUBMIT_AND_ROUTE','ACCEPT','REQUEST_INFO','ADD_INFO','RESOLVE','CONFIRM','REOPEN','CANCEL','AUTO_CLOSE','ACCEPT_HANDOVER','ACCEPT_OFFER','CLASSIFICATION_CORRECTED','PRIORITY_REVIEWED'])
    assert.equal(notificationAudience(action).requester,true,action);
  for (const action of ['WAIT_VENDOR','REASSIGN','ASSIGN_OFFER','ASSIGNMENT_EXPIRED','DECLINE_OFFER','CANCEL_OFFER','DECLINE_HANDOVER','CANCEL_HANDOVER','SLA_BREACH','OWNERSHIP_RECOVERED','OWNERSHIP_ESCALATION_REQUIRED','P1_CANDIDATE','P1_REVIEW_OVERDUE','P1_REVIEW_ROUTED','FEEDBACK_SUBMITTED'])
    assert.equal(notificationAudience(action).requester,undefined,action);
});

test('candidate, queue and escalation notifications are explicit, not group broadcasts', () => {
  assert.equal(notificationAudience('REASSIGN').pending,true);
  assert.equal(notificationAudience('ASSIGN_OFFER').pending,true);
  assert.equal(notificationAudience('ASSIGNMENT_EXPIRED').escalation,true);
  assert.equal(notificationAudience('ACCEPT_HANDOVER').pending,undefined);
  assert.equal(notificationAudience('SUBMIT_AND_ROUTE').queue,true);
  assert.equal(notificationAudience('REQUEST_INFO').queue,undefined);
  assert.equal(notificationAudience('SLA_BREACH').escalation,true);
  assert.equal(notificationAudience('OWNERSHIP_ESCALATION_REQUIRED').escalation,true);
  assert.equal(notificationAudience('OWNERSHIP_ESCALATION_REQUIRED').platformAdmin,true);
  assert.equal(notificationAudience('P1_REVIEW_OVERDUE').reviewer,true);
  assert.equal(notificationAudience('SLA_BREACH').reviewer,undefined);
});

test('unknown and internal-only future events fail closed, including object property names', () => {
  for (const action of ['INTERNAL_COMMENT','P1_UNKNOWN','NEW_UNKNOWN_ACTION','constructor','toString','__proto__',''])
    assert.deepEqual(notificationAudience(action),{});
});
