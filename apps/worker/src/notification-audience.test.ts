import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationAudience } from './notification-audience.js';

test('only named public progress events include the requester', () => {
  for (const action of ['SUBMIT_AND_ROUTE','ACCEPT','REQUEST_INFO','ADD_INFO','RESOLVE','CONFIRM','REOPEN','CANCEL','AUTO_CLOSE','ACCEPT_HANDOVER','CLASSIFICATION_CORRECTED','PRIORITY_REVIEWED'])
    assert.equal(notificationAudience(action).requester,true,action);
  for (const action of ['WAIT_VENDOR','REASSIGN','DECLINE_HANDOVER','CANCEL_HANDOVER','SLA_BREACH','OWNERSHIP_RECOVERED','P1_CANDIDATE','P1_REVIEW_OVERDUE','P1_REVIEW_ROUTED','FEEDBACK_SUBMITTED'])
    assert.equal(notificationAudience(action).requester,undefined,action);
});

test('candidate, queue and escalation notifications are explicit, not group broadcasts', () => {
  assert.equal(notificationAudience('REASSIGN').pending,true);
  assert.equal(notificationAudience('ACCEPT_HANDOVER').pending,undefined);
  assert.equal(notificationAudience('SUBMIT_AND_ROUTE').queue,true);
  assert.equal(notificationAudience('REQUEST_INFO').queue,undefined);
  assert.equal(notificationAudience('SLA_BREACH').escalation,true);
  assert.equal(notificationAudience('P1_REVIEW_OVERDUE').reviewer,true);
  assert.equal(notificationAudience('SLA_BREACH').reviewer,undefined);
});

test('unknown and internal-only future events fail closed, including object property names', () => {
  for (const action of ['INTERNAL_COMMENT','P1_UNKNOWN','NEW_UNKNOWN_ACTION','constructor','toString','__proto__',''])
    assert.deepEqual(notificationAudience(action),{});
});
