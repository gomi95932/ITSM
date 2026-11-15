import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='employee-1',body,key=randomUUID()){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query){
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
    let text='';child.stdout.on('data',chunk=>{text+=chunk;});child.stderr.resume();child.on('error',reject);
    child.on('close',code=>code===0?resolve(text.trim()):reject(new Error('PRIORITY_FIXTURE_SQL_FAILED')));
  });
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const reviewer='priority-reviewer-a',peer='priority-reviewer-b',ordinary='priority-ordinary',other='priority-other-group';
await sql(`INSERT INTO employees(id,display_name) VALUES ('${reviewer}','Reviewer A'),('${peer}','Reviewer B'),('${ordinary}','Ordinary agent'),('${other}','Other reviewer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES ('${reviewer}','service-desk'),('${peer}','service-desk'),('${ordinary}','service-desk'),('${other}','applications');
  INSERT INTO priority_reviewers(employee_id,group_id) VALUES ('${reviewer}','service-desk'),('${peer}','service-desk'),('${other}','applications');`);
async function create(user='employee-1',impact='COMPANY'){
  const result=await request('/tickets',user,{serviceCode:'INC-BIZ',formVersion:1,subject:`P1 ${randomUUID()}`,description:'Core production WMS unavailable',impact,urgency:'HIGH',fields:{}});
  assert.equal(result.status,201,JSON.stringify(result));return result.data;
}
const get=async(ticket,user=reviewer)=>(await request(`/tickets/${ticket.id}`,user)).data;
const review=(t,user=reviewer,priority='P1',reason='Verified production impact',key)=>request(`/tickets/${t.id}/priority-review`,user,{expectedVersion:t.version,priority,reason},key);
async function until(check){for(let i=0;i<80;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('PRIORITY_ALERT_TIMEOUT');}
let t=await create();
let detail=await get(t);assert.equal(detail.priority,'P1');assert.equal(detail.priorityReviewState,'PENDING');
assert.equal(detail.status,'QUEUED');assert.equal(detail.canReviewPriority,true);assert.equal(detail.sla[0].priority,'P1');
assert.equal((await get(t,ordinary)).canReviewPriority,false);
assert.equal((await review(t,ordinary)).status,403);assert.equal((await review(t,'employee-1')).status,403);
assert.equal((await review(t,other)).status,404);
assert.equal((await review(t,reviewer,'P1',' ')).status,400);
assert.equal(await sql(`SELECT count(*) FROM outbox_events o JOIN ticket_events e ON e.id=o.event_id
  WHERE o.ticket_id=${quote(t.id)} AND o.kind='P1_ALERT' AND e.action='P1_CANDIDATE'`),'1','candidate notification exists before confirmation');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e WHERE ticket_id=${quote(t.id)} AND NOT EXISTS
  (SELECT 1 FROM audit_logs a JOIN outbox_events o ON o.event_id=a.event_id WHERE a.event_id=e.id)`),'0');
await until(async()=>Number(await sql(`SELECT count(*) FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id
  WHERE o.ticket_id=${quote(t.id)} AND o.kind='P1_ALERT' AND d.employee_id=${quote(reviewer)} AND d.state='SIMULATED'`))===1);
// Work begins while supervisor confirmation is still pending.
const accepted=await request(`/tickets/${t.id}/actions`,ordinary,{action:'ACCEPT',expectedVersion:t.version,comment:'Investigating immediately'});
assert.equal(accepted.status,200);t=accepted.data;assert.equal((await get(t)).priorityReviewState,'PENDING');
const slaBefore=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(t.id)}`);
const timeBefore=await sql(`SELECT updated_at::text FROM tickets WHERE id=${quote(t.id)}`);
const before=t,key=randomUUID();const adjusted=await review(t,reviewer,'P2','Confirmed departmental rather than company impact',key);
assert.equal(adjusted.status,200,JSON.stringify(adjusted));t=adjusted.data;
assert.deepEqual((await review(before,reviewer,'P2','Confirmed departmental rather than company impact',key)).data,t);
assert.equal((await review(before,reviewer,'P3','Different body',key)).status,409);
assert.equal(t.status,'IN_PROGRESS');assert.equal(t.assigneeId,ordinary);
detail=await get(t);assert.equal(detail.priority,'P2');assert.equal(detail.priorityReviewState,'ADJUSTED');assert.equal(detail.canReviewPriority,false);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(t.id)}`),slaBefore);
assert.equal(await sql(`SELECT updated_at::text FROM tickets WHERE id=${quote(t.id)}`),timeBefore,'review must not extend pending-confirmation auto-close clock');
assert.equal((await review(t,peer)).status,409);
assert.equal(await sql(`SELECT count(*) FROM audit_logs WHERE ticket_id=${quote(t.id)} AND action='PRIORITY_REVIEWED'
  AND before_value->>'priority'='P1' AND after_value->>'priority'='P2' AND after_value->>'priorityReviewedBy'=${quote(reviewer)}`),'1');
const self=await create(reviewer);assert.equal((await review(self,reviewer)).status,403);
const nonP1=await create('employee-1','INDIVIDUAL');assert.equal((await review(nonP1)).status,409);
let raced=await create();const race=await Promise.all([review(raced,reviewer),review(raced,peer)]);
assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal((await get(raced)).priorityReviewState,'CONFIRMED');
let routed=await create();
assert.equal((await request(`/tickets/${routed.id}/actions`,ordinary,{action:'REASSIGN',expectedVersion:routed.version,targetGroupId:'applications',targetAssigneeId:other,reason:'Specialist takeover'})).status,403,'ordinary membership is not dispatcher appointment');
await sql(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,requested_by,reviewed_by,reason)
  VALUES(gen_random_uuid(),${quote(ordinary)},'DISPATCHER','service-desk',now(),now()+interval '1 day','ACTIVE','demo-admin-1','demo-admin-2','CI routing appointment')`);
let result=await request(`/tickets/${routed.id}/actions`,ordinary,{action:'REASSIGN',expectedVersion:routed.version,targetGroupId:'applications',targetAssigneeId:other,reason:'Specialist takeover'});assert.equal(result.status,200);routed=result.data;
result=await request(`/tickets/${routed.id}/actions`,other,{action:'ACCEPT_HANDOVER',expectedVersion:routed.version,comment:'Taking over response'});assert.equal(result.status,200);routed=result.data;
assert.equal((await review(routed,reviewer)).status,404);assert.equal((await get(routed,other)).canReviewPriority,true);
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${quote(routed.id)} AND action='P1_REVIEW_ROUTED'`),'1');
// Backdate only a disposable candidate; reminders are durable and deduplicated.
const overdue=await create();await sql(`UPDATE tickets SET priority_candidate_at=now()-interval '6 minutes' WHERE id=${quote(overdue.id)}`);
await until(async()=>await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${quote(overdue.id)} AND action='P1_REVIEW_OVERDUE'`)==='1');
assert.equal((await get(overdue)).priorityAlert.overdue,true);
await sql(`DELETE FROM priority_reviewers WHERE employee_id=${quote(reviewer)}`);
assert.equal((await review(overdue,reviewer)).status,403);
await sql(`UPDATE employees SET active=false WHERE id=${quote(peer)}`);assert.equal((await review(overdue,peer)).status,401);
await sql(`UPDATE employees SET active=true WHERE id=${quote(peer)}`);
console.log('P1 verified: immediate durable alert, response before review, scoped independent reviewers, concurrent/idempotent review, frozen SLA, rerouting, overdue and revocation');
