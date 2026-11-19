import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createFulfillmentFixture,fulfillmentSql as sql,literal as q } from '../support/fulfillment.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='agent-1',body,key=randomUUID()){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'X-Dev-User':user,
    'Content-Type':'application/json','Idempotency-Key':key},body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function ok(promise){const result=await promise;assert.equal(result.status,200,JSON.stringify(result));return result.data;}
const get=(f,user)=>request(`/tickets/${f.ticketId}`,user);
const rate=(f,user,body,key)=>request(`/tickets/${f.ticketId}/feedback`,user,body,key);
const action=(f,version,action,user='agent-1',extra={},key=randomUUID())=>
  request(`/tickets/${f.ticketId}/actions`,user,{action,expectedVersion:version,...extra},key);
const delivery={comment:'Requested service delivered and independently checked',resolutionCategory:'SERVICE_DELIVERED',evidence:'CI verification record'};
async function startSla(f){
  await sql(`INSERT INTO sla_cycles(ticket_id,cycle,priority,calendar_snapshot,started_at,response_target,resolution_target)
    SELECT ${q(f.ticketId)},1,'P3',config||jsonb_build_object('version',version,'approved',approved),now(),240,1440
    FROM sla_calendars ORDER BY version DESC LIMIT 1`);
}
async function effects(f){
  // The scheduler can record a reminder while a completion request is being rejected.
  return sql(`WITH reminders AS (
    SELECT e.id FROM ticket_events e JOIN request_fulfillment_signals s ON s.event_id=e.id
    WHERE e.ticket_id=${q(f.ticketId)} AND e.actor_id='system:scheduler'
      AND e.action='FULFILLMENT_'||s.kind AND e.from_status=e.to_status
  )
  SELECT jsonb_build_object('status',t.status,'version',t.version,'owner',t.assignee_id,
    'events',(SELECT count(*) FROM ticket_events e WHERE e.ticket_id=t.id AND e.action<>'SLA_BREACH'
      AND NOT EXISTS(SELECT 1 FROM reminders r WHERE r.id=e.id)),
    'audit',(SELECT count(*) FROM audit_logs a WHERE a.ticket_id=t.id AND a.action<>'SLA_BREACH'
      AND NOT (a.actor_id='system:scheduler' AND EXISTS(SELECT 1 FROM reminders r WHERE r.id=a.event_id))),
    'cycles',(SELECT jsonb_agg(to_jsonb(s) ORDER BY cycle) FROM sla_cycles s WHERE s.ticket_id=t.id))::text
    FROM tickets t WHERE t.id=${q(f.ticketId)}`);
}
async function completionDenied(f,user='agent-1',operation='RESOLVE'){
  const detail=await ok(get(f,user)),before=await effects(f),key=randomUUID();
  const result=await action(f,detail.version,operation,user,operation==='RESOLVE'?delivery:{},key);
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.data.code,'REQUEST_COMPLETION_NOT_READY');
  assert.equal(await effects(f),before,'a rejected completion must not mutate ticket, SLA or immutable events');
  assert.equal(await sql(`SELECT count(*) FROM api_idempotency WHERE actor_id=${q(user)} AND key=${q(key)}`),'0');
}

const f=await createFulfillmentFixture();await startSla(f);
assert.equal((await ok(get(f,'employee-1'))).canFeedback,false);
const earlyFeedback=await rate(f,'employee-1',{rating:5});
assert.equal(earlyFeedback.status,409);assert.equal(earlyFeedback.data.code,'FEEDBACK_NOT_AVAILABLE');
assert.notEqual((await sql(`INSERT INTO ticket_feedback(ticket_id,requester_id,rating)
  VALUES(${q(f.ticketId)},'employee-1',5)`,false)).code,0,'database rejects feedback before closure');
let detail=await ok(get(f));assert.equal(detail.requestCompletionReady,false);
let ticket=await ok(action(f,detail.version,'ACCEPT','agent-1',{comment:'I am responsible for delivery'}));
assert.equal(ticket.assigneeId,'agent-1');assert.equal(ticket.status,'IN_PROGRESS');
assert.equal((await ok(get(f))).canCorrectClassification,false);
await completionDenied(f);
const ownedOffer=await action(f,ticket.version,'ASSIGN_OFFER','agent-1',{targetAssigneeId:'agent-2',reason:'Cannot offer an owned ticket'});
assert.equal(ownedOffer.status,409);assert.equal(ownedOffer.data.code,'TICKET_ALREADY_ASSIGNED');
const classified=await request(`/tickets/${f.ticketId}/classification`,'agent-1',{
  expectedVersion:ticket.version,serviceCode:'INC-BIZ',formVersion:1,fields:{},reason:'Cannot replace approved request scope'});
assert.equal(classified.status,409);assert.equal(classified.data.code,'CLASSIFICATION_NOT_ALLOWED');

ticket=await ok(action(f,ticket.version,'REQUEST_INFO','agent-1',{
  comment:'Confirm the requested scope',waitingReason:'USER_INFORMATION',dueAt:new Date(Date.now()+3600000).toISOString()}));
let sla=(await ok(get(f))).sla.at(-1);assert.equal(sla.pauseReason,'USER');assert.equal(sla.paused,true);
ticket=await ok(action(f,ticket.version,'ADD_INFO','employee-1',{comment:'Requested scope confirmed'}));
sla=(await ok(get(f))).sla.at(-1);assert.equal(sla.paused,false);assert.equal(sla.pauseReason,null);
ticket=await ok(action(f,ticket.version,'WAIT_VENDOR','agent-1',{
  comment:'Waiting for vendor validation',vendorReference:'VENDOR-CI-1',vendorOwner:'CI engineer',
  waitingReason:'VENDOR_SUPPORT',dueAt:new Date(Date.now()+3600000).toISOString()}));
assert.equal(ticket.status,'WAITING_VENDOR');await completionDenied(f);
const task=await ok(request(`/fulfillments/${f.id}`,'agent-2'));
await ok(request(`/fulfillments/${f.id}/review`,'agent-2',{
  expectedVersion:task.version,reference:`REVIEW-LIFECYCLE-${randomUUID()}`}));
detail=await ok(get(f));assert.equal(detail.requestCompletionReady,true);
const resolveKey=randomUUID(),resolveVersion=ticket.version;
const submitted=await Promise.all([action(f,resolveVersion,'RESOLVE','agent-1',delivery,resolveKey),
  action(f,resolveVersion,'RESOLVE','agent-1',delivery,resolveKey)]);
submitted.forEach(result=>assert.equal(result.status,200,JSON.stringify(result)));assert.deepEqual(submitted[0].data,submitted[1].data);
ticket=submitted[0].data;assert.equal(ticket.status,'PENDING_CONFIRMATION');
assert.equal((await action(f,ticket.version,'CONFIRM','agent-2')).status,403,'a peer cannot confirm for the applicant');
assert.equal((await ok(get(f,'employee-1'))).requestCompletionReady,true);
ticket=await ok(action(f,ticket.version,'REOPEN','employee-1',{reason:'Please check one remaining setting'}));
assert.equal(ticket.status,'IN_PROGRESS');assert.equal((await ok(get(f))).sla.length,2);
assert.equal(await sql(`SELECT count(*) FROM request_approvals WHERE ticket_id=${q(f.ticketId)}`),'1');
assert.equal(await sql(`SELECT count(*) FROM request_fulfillments WHERE ticket_id=${q(f.ticketId)}`),'1');
ticket=await ok(action(f,ticket.version,'RESOLVE','agent-1',delivery));
const confirmKey=randomUUID(),confirmVersion=ticket.version;
const confirmed=await Promise.all([action(f,confirmVersion,'CONFIRM','employee-1',{},confirmKey),
  action(f,confirmVersion,'CONFIRM','employee-1',{},confirmKey)]);
confirmed.forEach(result=>assert.equal(result.status,200,JSON.stringify(result)));assert.deepEqual(confirmed[0].data,confirmed[1].data);
ticket=confirmed[0].data;assert.equal(ticket.status,'CLOSED');
assert.equal((await action(f,ticket.version,'REOPEN','employee-1',{reason:'Terminal tickets cannot reopen'})).status,409);
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id
  JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id=${q(f.ticketId)} AND e.action='CONFIRM'`),'1');
assert.equal(await sql(`SELECT state FROM request_fulfillments WHERE id=${q(f.id)}`),'DELIVERED','ticket closure is not permission revocation');

assert.equal((await ok(get(f,'employee-1'))).canFeedback,true);
assert.equal((await ok(get(f,'agent-1'))).canFeedback,false);
assert.equal((await rate(f,'agent-1',{rating:5})).status,403);
assert.equal((await rate(f,'employee-2',{rating:5})).status,404);
assert.notEqual((await sql(`INSERT INTO ticket_feedback(ticket_id,requester_id,rating)
  VALUES(${q(f.ticketId)},'employee-2',5)`,false)).code,0,'database rejects feedback by another requester');
const feedbackKey=randomUUID(),feedbackBody={rating:4,comment:'Service delivered as requested'};
const [feedback,replay]=await Promise.all([
  ok(rate(f,'employee-1',feedbackBody,feedbackKey)),ok(rate(f,'employee-1',feedbackBody,feedbackKey)),
]);
assert.deepEqual(feedback,replay);assert.equal(feedback.rating,4);
const changedFeedback=await rate(f,'employee-1',{rating:5},feedbackKey);
assert.equal(changedFeedback.status,409);assert.equal(changedFeedback.data.code,'IDEMPOTENCY_KEY_REUSED');
assert.equal((await rate(f,'employee-1',{rating:5})).status,409);
const rated=await ok(get(f,'employee-1'));
assert.equal(rated.canFeedback,false);assert.equal(rated.feedback.comment,feedbackBody.comment);
assert.equal(rated.version,ticket.version,'feedback does not change the ticket lifecycle version');
for(const mutation of [
  `UPDATE ticket_feedback SET rating=5 WHERE ticket_id=${q(f.ticketId)}`,
  `DELETE FROM ticket_feedback WHERE ticket_id=${q(f.ticketId)}`,
])assert.notEqual((await sql(mutation,false)).code,0,'request feedback remains immutable');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id
  JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id=${q(f.ticketId)} AND e.action='FEEDBACK_SUBMITTED'`),'1');
assert.equal(await sql(`SELECT state FROM request_fulfillments WHERE id=${q(f.id)}`),'DELIVERED');

// Each missing or stale prerequisite is independently rejected, not just hidden in the UI.
for(const state of [null,'READY','REVOKE_DUE','REVOKED','BLOCKED']){
  const blocked=await createFulfillmentFixture({state});
  await ok(action(blocked,1,'ACCEPT','agent-1',{comment:'Check delivery prerequisites'}));
  assert.equal((await ok(get(blocked))).requestCompletionReady,false);await completionDenied(blocked);
}
for(const [name,change] of [
  ['callback',f=>`UPDATE request_approvals SET state='PENDING',last_verified_at=NULL WHERE id=${q(f.approvalId)}`],
  ['withdrawal',f=>`UPDATE request_approvals SET state='WITHDRAWN',last_verified_at=NULL WHERE id=${q(f.approvalId)}`],
  ['identity',f=>`UPDATE identity_links SET ding_user_id=ding_user_id||'-changed' WHERE corp_id=(SELECT corp_id FROM request_approvals WHERE id=${q(f.approvalId)}) AND employee_id='employee-1'`],
  ['lease',f=>`UPDATE request_approvals SET lease_token=${q(randomUUID())},lease_until=now()+interval '1 minute' WHERE id=${q(f.approvalId)}`],
  ['pending',f=>`INSERT INTO request_delivery_commands(approval_id,actor_id,request_key,operation,expected_version,evidence_reference,request_hash)
    VALUES(${q(f.approvalId)},'agent-1',${q(randomUUID())},'DELIVER',1,'CI-PENDING',repeat('c',64))`],
  ['failed',f=>`INSERT INTO request_delivery_commands(approval_id,actor_id,request_key,operation,expected_version,evidence_reference,request_hash,state,error_code,completed_at)
    VALUES(${q(f.approvalId)},'agent-1',${q(randomUUID())},'DELIVER',1,'CI-FAILED',repeat('d',64),'REJECTED','CI_UNCERTAIN',now())`],
]){
  const blocked=await createFulfillmentFixture({reviewed:true});
  let pending=await ok(action(blocked,1,'ACCEPT','agent-1',{comment:`Verify ${name} boundary`}));
  pending=await ok(action(blocked,pending.version,'RESOLVE','agent-1',delivery));
  await sql(change(blocked));await completionDenied(blocked,'employee-1','CONFIRM');
  await ok(action(blocked,pending.version,'REOPEN','employee-1',{reason:`Investigate ${name}`}));
  await completionDenied(blocked);
  if(name==='pending'){
    await sql(`UPDATE request_delivery_commands SET state='REJECTED',error_code='CI_FIXTURE_CLOSED',completed_at=clock_timestamp()
      WHERE approval_id=${q(blocked.approvalId)} AND state='PENDING'`);
    assert.equal(await sql(`SELECT count(*) FROM request_delivery_commands WHERE approval_id=${q(blocked.approvalId)} AND state='PENDING'`),'0');
  }
}

// The worker must use the same prerequisites as explicit confirmation.
const automatic=await createFulfillmentFixture({reviewed:true}),invalidAuto=await createFulfillmentFixture({reviewed:true});
for(const candidate of [automatic,invalidAuto]){
  await startSla(candidate);
  let pending=await ok(action(candidate,1,'ACCEPT','agent-1',{comment:'Handle timed confirmation'}));
  pending=await ok(action(candidate,pending.version,'RESOLVE','agent-1',delivery));
}
await sql(`BEGIN;
  UPDATE request_approvals SET state='WITHDRAWN',last_verified_at=NULL WHERE id=${q(invalidAuto.approvalId)};
  UPDATE sla_cycles SET completed_at=now()-interval '73 hours' WHERE ticket_id IN (${q(automatic.ticketId)},${q(invalidAuto.ticketId)});
  UPDATE tickets SET sla_checked_at=NULL WHERE id IN (${q(automatic.ticketId)},${q(invalidAuto.ticketId)});
  COMMIT;`);
let closed=false;
for(let i=0;i<80;i++){
  if(await sql(`SELECT status FROM tickets WHERE id=${q(automatic.ticketId)}`)==='CLOSED'){closed=true;break;}
  await delay(1000);
}
assert.equal(closed,true,'valid REQ auto-closes after the confirmation window');
assert.equal(await sql(`SELECT status FROM tickets WHERE id=${q(invalidAuto.ticketId)}`),'PENDING_CONFIRMATION','withdrawn approval cannot auto-close');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id JOIN outbox_events o ON o.event_id=e.id
  WHERE e.ticket_id=${q(automatic.ticketId)} AND e.action='AUTO_CLOSE'`),'1');
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${q(invalidAuto.ticketId)} AND action='AUTO_CLOSE'`),'0');
assert.equal((await ok(get(automatic,'employee-1'))).canFeedback,true);
assert.equal((await ok(rate(automatic,'employee-1',{rating:5}))).rating,5);
assert.equal((await ok(get(invalidAuto,'employee-1'))).canFeedback,false);
console.log('REQ lifecycle verified: personal owner, independent review, completion gates, atomic replay, reopening without duplicate grant, identity/callback/failure boundaries and guarded auto-close');
