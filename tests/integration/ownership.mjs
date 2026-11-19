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
    child.on('close',code=>code===0?resolve(text.trim()):reject(new Error('OWNERSHIP_FIXTURE_SQL_FAILED')));
  });
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const a='ownership-agent-a',b='ownership-agent-b',c='ownership-agent-c';
await sql(`INSERT INTO employees(id,display_name) VALUES (${quote(a)},'Ownership A'),(${quote(b)},'Ownership B'),(${quote(c)},'Ownership C');
  INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(a)},'service-desk'),(${quote(b)},'service-desk'),(${quote(c)},'applications');`);
assert.equal((await request('/support-groups/service-desk/members')).status,404);
assert.equal((await request('/support-groups/missing/members',a)).status,404);
assert.ok((await request('/support-groups/service-desk/members',a)).data.items.some(person=>person.id===b));
async function create(){
  const result=await request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:`Ownership ${randomUUID()}`,description:'WMS page unavailable',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}});
  assert.equal(result.status,201,JSON.stringify(result));assert.equal(result.data.assigneeId,null);return result.data;
}
async function act(ticket,user,action,extra={},key){return request(`/tickets/${ticket.id}/actions`,user,{action,expectedVersion:ticket.version,...extra},key);}
async function ok(ticket,user,action,extra={},key){const result=await act(ticket,user,action,extra,key);assert.equal(result.status,200,JSON.stringify(result));return result.data;}
async function queue(user,kind,status=''){
  const response=await request(`/tickets?mine=false&queue=${kind}&page=1&size=100${status?`&status=${status}`:''}`,user);
  assert.equal(response.status,200,JSON.stringify(response));return response.data;
}
async function inQueue(ticket,user,kind,expected){
  const data=await queue(user,kind);assert.equal(data.items.some(row=>row.id===ticket.id),expected,`${kind} for ${user}`);
  assert.ok(data.workQueues[kind]>=Number(expected));
  assert.equal(data.items.length<=data.total,true);
  return data;
}
let t=await create();
assert.equal((await request('/tickets?mine=true&queue=assigned')).status,400);
assert.equal((await request('/tickets?mine=false&queue=unknown',a)).status,400);
assert.equal((await request('/tickets?mine=false&queue=assigned')).status,404);
await inQueue(t,a,'unassigned',true);
await inQueue(t,a,'assigned',false);
const race=await Promise.all([act(t,a,'ACCEPT',{comment:'Investigating'}),act(t,b,'ACCEPT',{comment:'Investigating'})]);
assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
t=race.find(r=>r.status===200).data;
const owner=t.assigneeId,peer=owner===a?b:a;
await inQueue(t,owner,'assigned',true);
await inQueue(t,peer,'assigned',false);
await inQueue(t,owner,'unassigned',false);
const peerDenied=await act(t,peer,'RESOLVE',{comment:'Restored',resolutionCategory:'FIX',evidence:'Verified'});
assert.equal(peerDenied.status,409);assert.equal(peerDenied.data.code,'PERSONAL_OWNER_REQUIRED');
assert.equal((await request(`/tickets/${t.id}`,c)).status,404);
assert.equal((await act(t,owner,'REASSIGN',{targetGroupId:'applications',targetAssigneeId:'employee-2',reason:'Specialist'})).status,400);
const handoverBody={targetGroupId:'applications',targetAssigneeId:c,reason:'Application specialist'};
const key=randomUUID(),old=t;
t=await ok(t,owner,'REASSIGN',handoverBody,key);
assert.equal(t.assigneeId,owner);assert.equal(t.ownerGroupId,'service-desk');assert.equal(t.pendingAssigneeId,c);
await inQueue(t,owner,'outgoing',true);
await inQueue(t,owner,'assigned',true);
await inQueue(t,c,'incoming',true);
await inQueue(t,c,'assigned',false);
await inQueue(t,b,'unassigned',false);
const scoped=await queue(c,'incoming','QUEUED');
assert.equal(scoped.items.some(row=>row.id===t.id),false);
assert.ok(scoped.counts.IN_PROGRESS>=1,'status totals are before the status filter');
assert.equal((await queue(c,'incoming')).workQueues.incoming,scoped.workQueues.incoming);
const named=(await queue(owner,'outgoing')).items.find(row=>row.id===t.id);
assert.equal(named.ownerGroupName,'IT 服务台');assert.equal(named.pendingAssigneeName,'Ownership C');
assert.deepEqual((await act(old,owner,'REASSIGN',handoverBody,key)).data,t,'handover request replay is stable');
assert.equal((await request(`/tickets/${t.id}`,owner)).status,200);
assert.equal((await request(`/tickets/${t.id}`,c)).status,200);
assert.ok((await request('/tickets?mine=false&page=1&size=100',c)).data.items.some(row=>row.id===t.id));
assert.equal((await act(t,peer,'ACCEPT_HANDOVER',{comment:'Not intended recipient'})).status,409);
assert.equal((await act(t,owner,'REASSIGN',handoverBody)).status,409);
t=await ok(t,c,'DECLINE_HANDOVER',{reason:'More information needed'});
await inQueue(t,c,'incoming',false);
await inQueue(t,owner,'outgoing',false);
assert.equal(t.assigneeId,owner);assert.equal(t.pendingAssigneeId,null);assert.equal((await request(`/tickets/${t.id}`,c)).status,404);
t=await ok(t,owner,'REASSIGN',handoverBody);
t=await ok(t,owner,'CANCEL_HANDOVER',{reason:'Handled by current team'});
assert.equal(t.pendingAssigneeId,null);assert.equal(t.assigneeId,owner);
t=await ok(t,owner,'REASSIGN',handoverBody);
const slaBefore=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(t.id)}`);
t=await ok(t,c,'ACCEPT_HANDOVER',{comment:'Received by applications'});
await inQueue(t,c,'incoming',false);
await inQueue(t,c,'assigned',true);
await inQueue(t,owner,'assigned',false);
assert.equal(t.ownerGroupId,'applications');assert.equal(t.assigneeId,c);assert.equal(t.pendingAssigneeId,null);
assert.equal((await request(`/tickets/${t.id}`,owner)).status,404);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(t.id)}`),slaBefore,'handover does not reset SLA');
assert.equal(await sql(`SELECT count(*) FROM audit_logs WHERE ticket_id=${quote(t.id)} AND action='ACCEPT_HANDOVER'
  AND before_value->>'assigneeId'=${quote(owner)} AND after_value->>'assigneeId'=${quote(c)}`),'1');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e WHERE e.ticket_id=${quote(t.id)} AND NOT EXISTS
  (SELECT 1 FROM audit_logs a JOIN outbox_events o ON o.event_id=a.event_id WHERE a.event_id=e.id)`),'0');
async function until(check){for(let i=0;i<80;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('OWNERSHIP_RECOVERY_TIMEOUT');}
// Disable only disposable users; do not change shared browser fixtures or real employees.
await sql(`UPDATE employees SET active=false WHERE id=${quote(c)}`);
assert.equal((await request(`/tickets/${t.id}`,c)).status,401);
await until(async()=>JSON.parse(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${quote(t.id)}`)).assignee_id===null);
const recovered=JSON.parse(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${quote(t.id)}`));
assert.equal(recovered.owner_group_id,'applications');assert.equal(recovered.status,'IN_PROGRESS');assert.equal(recovered.version,t.version+1);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(t.id)}`),slaBefore);
await sql(`UPDATE employees SET active=true WHERE id=${quote(c)}`);
await inQueue(t,c,'unassigned',true);
t=await ok({...t,version:recovered.version},c,'ACCEPT',{comment:'Reclaimed after recovery'});
assert.equal(t.status,'IN_PROGRESS');assert.equal(t.assigneeId,c);
// Membership removal invalidates only the named pending target, leaving current ownership intact.
let pending=await create();pending=await ok(pending,owner,'ACCEPT',{comment:'Investigating'});
pending=await ok(pending,owner,'REASSIGN',{targetGroupId:'service-desk',targetAssigneeId:peer,reason:'Same group handover'});
await sql(`DELETE FROM group_memberships WHERE employee_id=${quote(peer)} AND group_id='service-desk'`);
assert.equal((await request('/tickets?mine=false&queue=incoming',peer)).status,404);
assert.equal((await request(`/tickets/${pending.id}`,peer)).status,404);
await until(async()=>JSON.parse(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${quote(pending.id)}`)).pending_assignee_id===null);
const p=JSON.parse(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${quote(pending.id)}`));assert.equal(p.assignee_id,owner);
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(peer)},'service-desk')`);
// Unassigned routing retains the old group until the recipient confirms.
await sql(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,requested_by,reviewed_by,reason)
  VALUES(gen_random_uuid(),${quote(owner)},'DISPATCHER','service-desk',now(),now()+interval '1 day','ACTIVE','demo-admin-1','demo-admin-2','CI routing appointment')`);
let routed=await create();routed=await ok(routed,owner,'REASSIGN',handoverBody);
assert.equal(routed.status,'QUEUED');assert.equal(routed.assigneeId,null);
await inQueue(routed,owner,'unassigned',false);
await inQueue(routed,c,'incoming',true);
routed=await ok(routed,c,'ACCEPT_HANDOVER',{comment:'Taking queued work'});
await inQueue(routed,c,'assigned',true);
assert.equal(routed.status,'IN_PROGRESS');assert.equal(routed.assigneeId,c);
// A vacated owner group moves to the first configured group with active members.
const vacated=`vacated-${randomUUID()}`,middle=`empty-fallback-${randomUUID()}`,unroutable=`unroutable-${randomUUID()}`;
await sql(`INSERT INTO support_groups(id,name,fallback_group_id) VALUES
  (${quote(middle)},'Empty intermediate fallback','service-desk'),
  (${quote(vacated)},'Vacated support',${quote(middle)}),(${quote(unroutable)},'Unroutable support',NULL);
  INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(c)},${quote(vacated)}),(${quote(peer)},${quote(unroutable)});`);
let fallback=await create();fallback=await ok(fallback,owner,'REASSIGN',{targetGroupId:vacated,targetAssigneeId:c,reason:'Specialist group'});
fallback=await ok(fallback,c,'ACCEPT_HANDOVER',{comment:'Investigating in specialist group'});
const fallbackSla=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(fallback.id)}`);
await sql(`DELETE FROM group_memberships WHERE employee_id=${quote(c)} AND group_id=${quote(vacated)}`);
await until(async()=>await sql(`SELECT owner_group_id FROM tickets WHERE id=${quote(fallback.id)}`)==='service-desk');
const moved=JSON.parse(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${quote(fallback.id)}`));
assert.equal(moved.assignee_id,null);assert.equal(moved.status,'IN_PROGRESS');assert.equal(moved.version,fallback.version+1);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(fallback.id)}`),fallbackSla);
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${quote(fallback.id)} AND action='OWNERSHIP_RECOVERED'
  AND detail->>'reason'='OWNER_GROUP_UNAVAILABLE' AND detail->>'oldOwnerGroupId'=${quote(vacated)}`),'1');
assert.equal(await sql(`SELECT count(*) FROM audit_logs a JOIN outbox_events o ON o.event_id=a.event_id
  JOIN ticket_events e ON e.id=a.event_id WHERE e.ticket_id=${quote(fallback.id)} AND e.action='OWNERSHIP_RECOVERED'
  AND a.before_value->>'ownerGroupId'=${quote(vacated)} AND a.after_value->>'ownerGroupId'='service-desk'`),'1');
await inQueue(fallback,owner,'unassigned',true);

let stranded=await create();stranded=await ok(stranded,owner,'REASSIGN',{targetGroupId:unroutable,targetAssigneeId:peer,reason:'Specialist group'});
stranded=await ok(stranded,peer,'ACCEPT_HANDOVER',{comment:'Investigating'});
await sql(`DELETE FROM group_memberships WHERE employee_id=${quote(peer)} AND group_id=${quote(unroutable)}`);
await until(async()=>await sql(`SELECT count(*) FROM ticket_routing_alerts WHERE ticket_id=${quote(stranded.id)} AND resolved_at IS NULL`)==='1');
const strandedRow=JSON.parse(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${quote(stranded.id)}`));
assert.equal(strandedRow.owner_group_id,unroutable);assert.equal(strandedRow.assignee_id,null);
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${quote(stranded.id)} AND action='OWNERSHIP_ESCALATION_REQUIRED'`),'1');
assert.equal((await request('/routing-alerts','employee-1')).data.items.length,0);
const visibleAlert=(await request('/routing-alerts','demo-admin-1')).data.items.find(row=>row.ticketId===stranded.id);
assert.ok(visibleAlert);
assert.equal(visibleAlert.ownerGroupId,unroutable);
assert.ok(visibleAlert.ownerGroupName);
assert.equal(visibleAlert.reason,'NO_ACTIVE_FALLBACK');
assert.equal(visibleAlert.subject,undefined);
assert.equal(visibleAlert.description,undefined);
const firstAlertCheck=await sql(`SELECT last_checked_at::text FROM ticket_routing_alerts
  WHERE ticket_id=${quote(stranded.id)} AND resolved_at IS NULL`);
assert.ok(firstAlertCheck);
await until(async()=>await sql(`SELECT count(*) FROM ticket_routing_alerts
  WHERE ticket_id=${quote(stranded.id)} AND resolved_at IS NULL
    AND last_checked_at>${quote(firstAlertCheck)}::timestamptz`)==='1');
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${quote(stranded.id)} AND action='OWNERSHIP_ESCALATION_REQUIRED'`),'1',
  'an unresolved alert does not create duplicate escalation events on each scan');
await sql(`UPDATE support_groups SET fallback_group_id='service-desk' WHERE id=${quote(unroutable)}`);
await until(async()=>await sql(`SELECT owner_group_id FROM tickets WHERE id=${quote(stranded.id)}`)==='service-desk');
assert.equal(await sql(`SELECT count(*) FROM ticket_routing_alerts WHERE ticket_id=${quote(stranded.id)} AND resolved_at IS NOT NULL`),'1');
assert.equal((await request('/routing-alerts','demo-admin-1')).data.items.some(row=>row.ticketId===stranded.id),false);
console.log('Personal ownership verified: concurrent claim, peer denial, confirmed handover, recovery, immutable SLA and audit/outbox');
