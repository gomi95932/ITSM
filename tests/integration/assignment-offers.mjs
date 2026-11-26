import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='employee-1',body,key=randomUUID()) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},
    body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml',
      'exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],
      {stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.on('error',reject);
    child.on('close',code=>code===0?resolve(output.trim()):reject(new Error('ASSIGNMENT_FIXTURE_SQL_FAILED')));
  });
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
async function create(urgency='MEDIUM') {
  const result=await request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:`Candidate ${randomUUID()}`,
    description:'WMS page unavailable',impact:'INDIVIDUAL',urgency,fields:{}});
  assert.equal(result.status,201,JSON.stringify(result));return result.data;
}
async function act(ticket,user,action,extra={},key=randomUUID()) {
  return request(`/tickets/${ticket.id}/actions`,user,{action,expectedVersion:ticket.version,...extra},key);
}
async function ok(ticket,user,action,extra={},key) {
  const result=await act(ticket,user,action,extra,key);assert.equal(result.status,200,JSON.stringify(result));return result.data;
}
async function until(check) {
  for(let i=0;i<80;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,1000));}
  throw new Error('ASSIGNMENT_EXPIRY_TIMEOUT');
}
const dispatcher='agent-1',candidate='agent-3';
const peer=`offer-peer-${randomUUID()}`;
await sql(`INSERT INTO employees(id,display_name) VALUES (${quote(peer)},'Offer peer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(peer)},'service-desk');`);

let ticket=await create();
assert.equal((await request(`/tickets/${ticket.id}`,dispatcher)).data.canAssignOffer,true);
const offer={targetAssigneeId:candidate,reason:'WMS support candidate'};
assert.equal((await act(ticket,peer,'ASSIGN_OFFER',offer)).status,403);
assert.equal((await act(ticket,dispatcher,'ASSIGN_OFFER',{...offer,targetAssigneeId:'employee-1'})).status,400);
assert.equal((await act(ticket,dispatcher,'ASSIGN_OFFER',{...offer,targetGroupId:'applications'})).status,400);
const key=randomUUID(),old=ticket;
ticket=await ok(ticket,dispatcher,'ASSIGN_OFFER',offer,key);
assert.equal(ticket.status,'QUEUED');assert.equal(ticket.assigneeId,null);
assert.equal(ticket.pendingAssigneeId,candidate);assert.equal(ticket.assignmentKind,'OFFER');
assert.ok(Date.parse(ticket.assignmentDueAt)>Date.now());
for(const [user,mine] of [['employee-1',true],[dispatcher,false]]) {
  const list=await request(`/tickets?mine=${mine}&page=1&size=100`,user);
  assert.equal(list.status,200,JSON.stringify(list));
  const offered=list.data.items.find(item=>item.id===ticket.id);
  assert.ok(offered,'the pending offer remains visible in requester and support lists');
  assert.equal(offered.assignmentDueAt,ticket.assignmentDueAt,'JSON-aggregated deadlines serialize like direct receipts');
}
assert.deepEqual((await act(old,dispatcher,'ASSIGN_OFFER',offer,key)).data,ticket);
assert.equal((await act(ticket,peer,'ACCEPT',{comment:'Taking it'})).data.code,'HANDOVER_PENDING');
assert.equal((await act(ticket,peer,'ACCEPT_OFFER',{comment:'Taking it'})).status,409);
assert.equal((await act(ticket,candidate,'ACCEPT_HANDOVER',{comment:'Wrong kind'})).status,409);
assert.equal((await act(ticket,peer,'CANCEL_OFFER',{reason:'Wrong authority'})).status,403);
const sla=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`);
ticket=await ok(ticket,candidate,'ACCEPT_OFFER',{comment:'I will investigate'});
assert.equal(ticket.status,'IN_PROGRESS');assert.equal(ticket.assigneeId,candidate);assert.equal(ticket.pendingAssigneeId,null);
assert.equal(ticket.assignmentState,'ACCEPTED');
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`),sla);
assert.equal(await sql(`SELECT count(*) FROM audit_logs WHERE ticket_id=${quote(ticket.id)} AND action='ACCEPT_OFFER' AND
  before_value->>'assigneeId' IS NULL AND after_value->>'assigneeId'=${quote(candidate)}`),'1');

let declined=await create();declined=await ok(declined,dispatcher,'ASSIGN_OFFER',offer);
declined=await ok(declined,candidate,'DECLINE_OFFER',{reason:'Out of scope'});
assert.equal(declined.assigneeId,null);assert.equal(declined.pendingAssigneeId,null);assert.equal(declined.assignmentState,'DECLINED');
let withdrawn=await create();withdrawn=await ok(withdrawn,dispatcher,'ASSIGN_OFFER',offer);
withdrawn=await ok(withdrawn,dispatcher,'CANCEL_OFFER',{reason:'Candidate unavailable'});
assert.equal(withdrawn.assignmentState,'CANCELLED');assert.equal(withdrawn.assigneeId,null);

let expired=await create();expired=await ok(expired,dispatcher,'ASSIGN_OFFER',offer);
const expiredSla=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(expired.id)}`);
await sql(`UPDATE tickets SET assignment_due_at=now()-interval '1 second' WHERE id=${quote(expired.id)}`);
const lateAcceptance=await act(expired,candidate,'ACCEPT_OFFER',{comment:'Too late'});
assert.equal(lateAcceptance.status,409);
// The scheduler can expire the offer before the stale acceptance acquires its lock.
assert.ok(['HANDOVER_EXPIRED','VERSION_CONFLICT'].includes(lateAcceptance.data.code),JSON.stringify(lateAcceptance));
await until(async()=>await sql(`SELECT assignment_state FROM tickets WHERE id=${quote(expired.id)}`)==='EXPIRED');
const row=JSON.parse(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${quote(expired.id)}`));
assert.equal(row.assignee_id,null);assert.equal(row.pending_assignee_id,null);assert.equal(row.status,'QUEUED');
if(lateAcceptance.data.code==='VERSION_CONFLICT')assert.ok(row.version>expired.version,'scheduler expiry must explain the version conflict');
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(expired.id)}`),expiredSla);
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${quote(expired.id)} AND action='ASSIGNMENT_EXPIRED'`),'1');
assert.equal(await sql(`SELECT count(*) FROM outbox_events o JOIN ticket_events e ON e.id=o.event_id
  WHERE e.ticket_id=${quote(expired.id)} AND e.action='ASSIGNMENT_EXPIRED'`),'1');

let noPolicy=await create('LOW');
assert.equal((await request(`/tickets/${noPolicy.id}`,dispatcher)).data.canAssignOffer,true);
noPolicy=await ok(noPolicy,dispatcher,'ASSIGN_OFFER',offer);
assert.ok(Date.parse(noPolicy.assignmentDueAt)>Date.now(),'missing policy uses a bounded default receipt window');
noPolicy=await ok(noPolicy,dispatcher,'CANCEL_OFFER',{reason:'Default policy offer verified'});
let breached=await create();
await sql(`UPDATE sla_cycles SET started_at=now()-interval '30 days' WHERE ticket_id=${quote(breached.id)}`);
assert.equal((await request(`/tickets/${breached.id}`,dispatcher)).data.canAssignOffer,true);
const breachedSla=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(breached.id)}`);
breached=await ok(breached,dispatcher,'ASSIGN_OFFER',offer);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(breached.id)}`),breachedSla);
breached=await ok(breached,dispatcher,'CANCEL_OFFER',{reason:'Overdue assignment verified'});
breached=await ok(breached,dispatcher,'REASSIGN',{targetGroupId:'service-desk',targetAssigneeId:candidate,reason:'Recover breached ticket'});
assert.equal(breached.assignmentKind,'HANDOVER');
assert.ok(Date.parse(breached.assignmentDueAt)>Date.now(),'handover remains actionable after an SLA breach');
breached=await ok(breached,candidate,'ACCEPT_HANDOVER',{comment:'Taking overdue ticket'});
assert.equal(breached.assigneeId,candidate);
const race=await create();
const results=await Promise.all([act(race,dispatcher,'ASSIGN_OFFER',offer),act(race,peer,'ACCEPT',{comment:'Claiming'})]);
assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
console.log('Candidate offer verified: role, reservation, acceptance, decline, retract, expiry, overdue handover, immutable SLA and concurrent claim');
