import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='employee-1',body,key=randomUUID()){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query){return new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
  let text='';child.stdout.on('data',c=>{text+=c;});child.stderr.resume();child.on('error',reject);child.on('close',c=>c===0?resolve(text.trim()):reject(new Error('PRIORITY_GOVERNANCE_SQL_FAILED')));
});}
const q=v=>`'${String(v).replaceAll("'","''")}'`;
const engineer='governance-engineer',reviewer='governance-reviewer',peer='governance-peer';
await sql(`INSERT INTO employees(id,display_name) VALUES ('${engineer}','Governance engineer'),('${reviewer}','Governance reviewer'),('${peer}','Governance peer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES ('${engineer}','service-desk'),('${reviewer}','service-desk'),('${peer}','service-desk');
  INSERT INTO priority_reviewers(employee_id,group_id) VALUES ('${reviewer}','service-desk'),('${peer}','service-desk');`);
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
const create=async()=>ok(await request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:'Priority governance fixture',description:'One workstation intermittently slow; work continues',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}}),201);
const get=async t=>ok(await request(`/tickets/${t.id}`,engineer));
const body=(t,priority,mode='APPLY')=>({expectedVersion:t.version,priority,impact:'INDIVIDUAL',urgency:'HIGH',reason:'Verified actual impact and workaround availability',mode});
const change=(t,user,priority,mode,key)=>request(`/tickets/${t.id}/priority`,user,body(t,priority,mode),key);
let t=await create();let d=await get(t);assert.equal(d.priority,'P3');assert.equal(d.initialPriority,'P3');
assert.equal((await change(t,'employee-1','P1','APPLY')).status,403);
assert.equal((await change(t,engineer,'P2','APPLY')).status,403,'unassigned membership is insufficient');
t=ok(await request(`/tickets/${t.id}/actions`,engineer,{action:'ACCEPT',expectedVersion:t.version,comment:'Checking the workstation'}));
const before=t,key=randomUUID();t=ok(await change(t,engineer,'P2','APPLY',key));
assert.deepEqual(ok(await change(before,engineer,'P2','APPLY',key)),t);
assert.equal((await change(before,engineer,'P1','APPLY',key)).status,409);
d=await get(t);assert.equal(d.initialPriority,'P3');assert.equal(d.priority,'P2');assert.equal(d.sla[0].priority,'P3');assert.equal(d.sla[0].obligations.length,1);
assert.equal(d.events.find(e=>e.action==='PRIORITY_CHANGED').actorId,engineer);
assert.equal((await change(t,engineer,'P4','APPLY')).status,403);
t=ok(await change(t,engineer,'P4','SUGGEST'));assert.equal((await get(t)).priority,'P2');
const originalClock=await sql(`SELECT started_at::text||'|'||response_target||'|'||resolution_target FROM sla_cycles WHERE ticket_id=${q(t.id)}`);
t=ok(await change(t,reviewer,'P1','APPLY'));assert.equal((await get(t)).priorityReviewState,'PENDING');
assert.equal((await request(`/tickets/${t.id}/priority-review`,reviewer,{expectedVersion:t.version,priority:'P1',reason:'Self confirmation must be denied'})).status,403);
t=ok(await request(`/tickets/${t.id}/priority-review`,peer,{expectedVersion:t.version,priority:'P2',reason:'Independent review establishes limited impact'}));
assert.equal((await get(t)).sla[0].obligations.length,2);
assert.equal(await sql(`SELECT started_at::text||'|'||response_target||'|'||resolution_target FROM sla_cycles WHERE ticket_id=${q(t.id)}`),originalClock);
t=ok(await change(t,reviewer,'P1','APPLY'));assert.equal((await get(t)).priorityReviewState,'PENDING');
assert.equal(await sql(`SELECT count(*) FROM priority_review_signals WHERE ticket_id=${q(t.id)} AND kind='CANDIDATE'`),'2','each reentry gets a new candidate generation');
assert.equal((await change(before,reviewer,'P2','SUGGEST')).status,409);
assert.equal(await sql(`SELECT count(*) FROM ticket_events e WHERE e.ticket_id=${q(t.id)} AND e.action IN ('PRIORITY_CHANGED','PRIORITY_SUGGESTED')
  AND NOT EXISTS(SELECT 1 FROM audit_logs a JOIN outbox_events o ON o.event_id=a.event_id WHERE a.event_id=e.id)`),'0');

assert.equal((await request('/admin/priority-policy','employee-1')).status,403);
const current=ok(await request('/admin/priority-policy','demo-admin-1')).current;
const config=structuredClone(current.config);config.criticalServices=['INC-BIZ'];config.reviewMinutes=7;
const proposalBody={id:randomUUID(),expectedVersion:current.version,config,reason:'CI critical-service policy'};
const proposal=ok(await request('/admin/priority-policy','demo-admin-1',proposalBody),201);
assert.equal(ok(await request('/admin/priority-policy','demo-admin-1',proposalBody),201).id,proposal.id);
assert.equal((await request(`/admin/priority-policy/${proposal.id}/review`,'demo-admin-1',{expectedVersion:1,decision:'APPROVE',reason:'Self approval must fail'})).status,403);
ok(await request(`/admin/priority-policy/${proposal.id}/review`,'demo-admin-2',{expectedVersion:1,decision:'APPROVE',reason:'Independent review'}),201);
assert.equal((await get(t)).priorityPolicyVersion,current.version,'existing tickets keep their creation rule');
const latest=ok(await request('/admin/priority-policy','demo-admin-1')).current;assert.equal(latest.version,current.version+1);assert.equal(latest.approved,true);
const newTicket=ok(await request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:'Critical interruption',description:'Critical business service interrupted without workaround',impact:'INDIVIDUAL',urgency:'HIGH',fields:{}}),201);
assert.equal((await get(newTicket)).priority,'P1');
const invalid=structuredClone(config);invalid.matrix.COMPANY.HIGH='P4';
assert.equal((await request('/admin/priority-policy','demo-admin-1',{id:randomUUID(),expectedVersion:latest.version,config:invalid,reason:'Contradictory matrix'})).status,400);
// Restore defaults through the same approved API so subsequent suites remain independent.
const restore=ok(await request('/admin/priority-policy','demo-admin-1',{id:randomUUID(),expectedVersion:latest.version,config:current.config,reason:'Restore isolated CI defaults'}),201);
ok(await request(`/admin/priority-policy/${restore.id}/review`,'demo-admin-2',{expectedVersion:1,decision:'APPROVE',reason:'Restore reviewed'}),201);
console.log('Priority governance: permissions, independent review, replay, SLA preservation, generations, policy approval and snapshots passed');
