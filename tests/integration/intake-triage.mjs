import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1',requester='triage-requester',proxy='triage-proxy',owner='triage-owner',peer='triage-peer';
async function request(path,user=requester,body,key=randomUUID()){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query){
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
    let text='';child.stdout.on('data',chunk=>{text+=chunk;});child.on('error',reject);
    child.on('close',code=>code===0?resolve(text.trim()):reject(new Error('TRIAGE_FIXTURE_SQL_FAILED')));
  });
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
await sql(`INSERT INTO employees(id,display_name) VALUES ('${requester}','Triage employee'),('${proxy}','Triage proxy'),('${owner}','Triage owner'),('${peer}','Triage peer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES ('${proxy}','applications'),('${owner}','service-desk'),('${peer}','service-desk');
  INSERT INTO service_catalog(code,type,form_version,published,group_id,name,visible_groups) VALUES
    ('INC-TRIAGE-HIDDEN','INC',1,true,'service-desk','Restricted','["applications"]'),
    ('INC-TRIAGE-OFF','INC',1,false,'service-desk','Unpublished','[]'),
    ('INC-TRIAGE-APP','INC',1,true,'applications','Application triage','[]');`);
async function create(user=requester,extra={},key){
  return request('/tickets',user,{serviceCode:'GEN-OTHER',formVersion:1,subject:`Triage ${randomUUID()}`,description:'Please help identify this ordinary IT request',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{},...extra},key);
}
async function grant(){
  const body={id:randomUUID(),delegateId:proxy,expiresAt:new Date(Date.now()+3600000).toISOString(),consent:true};
  // Unlike ticket APIs, a grant must reject unexpected content fields.
  const send=async(payload,user=requester)=>{
    const response=await fetch(base+'/delegations',{method:'POST',headers:{'Content-Type':'application/json','X-Dev-User':user},body:JSON.stringify(payload)});
    return {status:response.status,data:await response.json()};
  };
  assert.equal((await send({...body,delegateId:requester})).status,400);
  assert.equal((await send({...body,delegateId:'employee-2'})).status,400);
  assert.equal((await send({...body,consent:false})).status,400);
  assert.equal((await send({...body,expiresAt:new Date(Date.now()+8*86400000).toISOString()})).status,409);
  const result=await send(body);assert.equal(result.status,201,JSON.stringify(result));
  assert.deepEqual((await send(body)).data,result.data);
  assert.equal((await send({...body,expiresAt:new Date(Date.now()+7200000).toISOString()})).status,409);
  assert.equal(await sql(`SELECT count(*) FROM operational_audits WHERE action='DELEGATION_GRANTED' AND target_id=${quote(body.id)}`),'1');
  return body.id;
}
const catalog=await request('/catalog');assert.equal(catalog.data.items.find(i=>i.code==='GEN-OTHER')?.available,true);
for(const code of ['INC-NONEXISTENT','INC-TRIAGE-OFF','INC-TRIAGE-HIDDEN'])assert.equal((await create(requester,{serviceCode:code})).status,400);
assert.equal((await create(requester,{serviceCode:'REQ-ACCOUNT'})).status,503,'GEN must not unlock request fulfillment');
assert.equal((await create(requester,{requesterId:'employee-2'})).status,400);
const cancelCreated=await create();assert.equal(cancelCreated.status,201,JSON.stringify(cancelCreated));
const cancelTicket=cancelCreated.data,cancelPath=`/tickets/${cancelTicket.id}/actions`,cancelBody={action:'CANCEL',expectedVersion:cancelTicket.version},cancelKey=randomUUID();
assert.equal((await request(cancelPath,peer,cancelBody)).status,403,'visible agent cannot cancel for the requester');
assert.equal((await request(cancelPath,requester,{...cancelBody,expectedVersion:cancelTicket.version+1})).status,409,'stale version cannot cancel');
const cancelled=await request(cancelPath,requester,cancelBody,cancelKey);
assert.equal(cancelled.status,200,JSON.stringify(cancelled));assert.equal(cancelled.data.status,'CANCELLED');
assert.deepEqual((await request(cancelPath,requester,cancelBody,cancelKey)).data,cancelled.data,'same key and request replay the receipt');
assert.equal((await request(cancelPath,requester,{...cancelBody,reason:'Changed request'},cancelKey)).status,409,'same key with a different body is rejected');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id JOIN outbox_events o ON o.event_id=e.id
  WHERE e.ticket_id=${quote(cancelTicket.id)} AND e.action='CANCEL' AND e.actor_id=${quote(requester)} AND e.to_status='CANCELLED'`),'1');
const raceCreated=await create();assert.equal(raceCreated.status,201,JSON.stringify(raceCreated));
const raceTicket=raceCreated.data,raceBody={action:'CANCEL',expectedVersion:raceTicket.version};
const cancelRaces=await Promise.all([request(`/tickets/${raceTicket.id}/actions`,requester,raceBody),request(`/tickets/${raceTicket.id}/actions`,requester,raceBody)]);
assert.deepEqual(cancelRaces.map(r=>r.status).sort(),[200,409],'concurrent distinct cancellation keys have one winner');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id JOIN outbox_events o ON o.event_id=e.id
  WHERE e.ticket_id=${quote(raceTicket.id)} AND e.action='CANCEL'`),'1');
const historical=(await create()).data,grantId=await grant();
assert.equal((await request(`/tickets/${historical.id}`,proxy)).status,404,'a grant is not access to historical tickets');
const submitted={delegationId:grantId,subject:`Delegated ${randomUUID()}`},creationKey=randomUUID();
let result=await create(proxy,submitted,creationKey);assert.equal(result.status,201,JSON.stringify(result));let t=result.data;
let detail=(await request(`/tickets/${t.id}`,proxy)).data;
assert.equal(detail.requesterId,requester);assert.equal(detail.submittedById,proxy);assert.equal(detail.serviceType,'GEN');assert.equal(detail.canAddInfo,true);
assert.equal((await request(`/tickets/${t.id}`,requester)).status,200);
assert.equal((await request(`/tickets/${t.id}`,peer)).status,200,'independent queue permission is unchanged');
assert.equal((await request('/tickets?mine=true&page=1&size=100',proxy)).data.items.some(i=>i.id===t.id),true);
assert.equal((await request('/tickets?mine=true&page=1&size=100',proxy)).data.items.some(i=>i.id===historical.id),false);
assert.equal((await request(`/tickets/${t.id}/actions`,proxy,{action:'CANCEL',expectedVersion:t.version})).status,403);
assert.equal((await request(`/delegations/${grantId}/revoke`,proxy,{})).status,404);
// A proxy with independent supervisor authority may not confirm their own submission.
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(proxy)},'service-desk');
  INSERT INTO priority_reviewers(employee_id,group_id) VALUES (${quote(proxy)},'service-desk')`);
const p1=(await create(proxy,{delegationId:grantId,impact:'COMPANY',urgency:'HIGH'})).data;
assert.equal((await request(`/tickets/${p1.id}/priority-review`,proxy,{expectedVersion:p1.version,priority:'P1',reason:'Independent review required'})).status,403);
await sql(`DELETE FROM priority_reviewers WHERE employee_id=${quote(proxy)} AND group_id='service-desk';
  DELETE FROM group_memberships WHERE employee_id=${quote(proxy)} AND group_id='service-desk'`);
const action=async(ticket,user,name,fields={})=>{
  const response=await request(`/tickets/${ticket.id}/actions`,user,{action:name,expectedVersion:ticket.version,...fields});
  assert.equal(response.status,200,JSON.stringify(response));return response.data;
};
t=await action(t,owner,'ACCEPT',{comment:'Triage started'});
t=await action(t,owner,'REQUEST_INFO',{comment:'Please clarify the network location',dueAt:new Date(Date.now()+86400000).toISOString()});
t=await action(t,proxy,'ADD_INFO',{comment:'Office floor two'});
const classify=(ticket,user=owner,extra={},key)=>request(`/tickets/${ticket.id}/classification`,user,{expectedVersion:ticket.version,serviceCode:'INC-NET',formVersion:1,fields:{location:'Office floor two'},reason:'Confirmed network issue',...extra},key);
assert.equal((await classify(t,requester)).status,403);assert.equal((await classify(t,peer)).status,403);
assert.equal((await classify(t,owner,{fields:{}})).status,400);
assert.equal((await classify(t,owner,{formVersion:2})).status,409);
assert.equal((await classify(t,owner,{serviceCode:'REQ-ACCOUNT',fields:{}})).status,503);
assert.equal((await classify(t,owner,{serviceCode:'INC-TRIAGE-APP',fields:{}})).status,409);
assert.equal((await classify(t,owner,{serviceCode:'INC-TRIAGE-HIDDEN',fields:{}})).status,400,'both actor and requester must see target catalog');
assert.equal((await classify(t,owner,{reason:'password=blocked-triage-sentinel'})).status,403);
const preserved=await sql(`SELECT json_build_object('sla',(SELECT row_to_json(s) FROM sla_cycles s WHERE s.ticket_id=t.id),'updated',updated_at,
  'original',original_catalog_snapshot,'fields',original_fields,'owner',owner_group_id,'assignee',assignee_id,'priority',priority)::text FROM tickets t WHERE id=${quote(t.id)}`);
const before=t,correctionKey=randomUUID();result=await classify(t,owner,{},correctionKey);assert.equal(result.status,200,JSON.stringify(result));t=result.data;
assert.deepEqual((await classify(before,owner,{},correctionKey)).data,t);
assert.equal((await classify(before,owner,{reason:'Changed body'},correctionKey)).status,409);
assert.equal(await sql(`SELECT json_build_object('sla',(SELECT row_to_json(s) FROM sla_cycles s WHERE s.ticket_id=t.id),'updated',updated_at,
  'original',original_catalog_snapshot,'fields',original_fields,'owner',owner_group_id,'assignee',assignee_id,'priority',priority)::text FROM tickets t WHERE id=${quote(t.id)}`),preserved);
detail=(await request(`/tickets/${t.id}`,owner)).data;assert.equal(detail.serviceCode,'INC-NET');assert.equal(detail.originalServiceCode,'GEN-OTHER');
assert.equal((await classify(t)).status,409,'same classification is rejected');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id JOIN outbox_events o ON o.event_id=e.id
  WHERE e.ticket_id=${quote(t.id)} AND e.action='CLASSIFICATION_CORRECTED' AND a.before_value->>'serviceCode'='GEN-OTHER' AND a.after_value->>'serviceCode'='INC-NET'`),'1');
const races=await Promise.all([classify(t,owner,{serviceCode:'INC-PC',fields:{}}),classify(t,owner,{serviceCode:'INC-MAIL',fields:{}})]);
assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);t=races.find(r=>r.status===200).data;
t=await action(t,owner,'REASSIGN',{targetGroupId:'applications',targetAssigneeId:proxy,reason:'Application team should continue'});
assert.equal((await classify(t,owner,{serviceCode:'INC-BIZ',fields:{}})).status,409,'no correction during pending handover');
t=await action(t,proxy,'ACCEPT_HANDOVER',{comment:'Application team accepts'});
result=await classify(t,proxy,{serviceCode:'INC-TRIAGE-APP',fields:{}});assert.equal(result.status,200);t=result.data;
t=await action(t,proxy,'RESOLVE',{comment:'Ordinary issue resolved',resolutionCategory:'Guidance',evidence:'User workflow verified'});
assert.equal((await classify(t,proxy,{serviceCode:'GEN-OTHER',fields:{}})).status,409);
assert.equal((await request(`/tickets/${t.id}/actions`,proxy,{action:'CONFIRM',expectedVersion:t.version})).status,403,'independent agent role cannot become the requester');
assert.equal((await request(`/tickets/${t.id}/actions`,proxy,{action:'REOPEN',expectedVersion:t.version,reason:'Cannot act for employee'})).status,403);
t=await action(t,requester,'CONFIRM');assert.equal((await classify(t,proxy,{serviceCode:'GEN-OTHER',fields:{}})).status,409);
// Use tickets outside the proxy's independent queue/reviewer scopes for revocation tests.
const delegated=(await create(proxy,{delegationId:grantId})).data;
assert.equal((await request(`/delegations/${grantId}/revoke`,requester,{})).status,200);
assert.equal((await request(`/delegations/${grantId}/revoke`,requester,{})).status,200);
assert.equal(await sql(`SELECT count(*) FROM operational_audits WHERE action='DELEGATION_REVOKED' AND target_id=${quote(grantId)}`),'1');
assert.equal((await request(`/tickets/${delegated.id}`,proxy)).status,404);
assert.equal((await create(proxy,submitted,creationKey)).status,403,'replay is checked against current grant');
assert.equal((await request('/tickets?mine=true&page=1&size=100',proxy)).data.items.some(i=>i.id===delegated.id),false);
assert.equal((await request(`/tickets/${delegated.id}/actions`,proxy,{action:'ADD_INFO',expectedVersion:delegated.version,comment:'No longer authorized'})).status,404);
const second=await grant(),expiring=(await create(proxy,{delegationId:second})).data;
await sql(`UPDATE ticket_delegations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=${quote(second)}`);
assert.equal((await request(`/tickets/${expiring.id}`,proxy)).status,404);assert.equal((await create(proxy,{delegationId:second})).status,403);
const third=await grant(),disabled=(await create(proxy,{delegationId:third})).data;
await sql(`UPDATE employees SET active=false WHERE id=${quote(requester)}`);
assert.equal((await request(`/tickets/${disabled.id}`,proxy)).status,404);assert.equal((await create(proxy,{delegationId:third})).status,403);
await sql(`UPDATE employees SET active=true WHERE id=${quote(requester)};DELETE FROM group_memberships WHERE employee_id=${quote(proxy)}`);
assert.equal((await request(`/tickets/${disabled.id}`,proxy)).status,404);assert.equal((await create(proxy,{delegationId:third})).status,403);
assert.equal(await sql(`SELECT count(*) FROM tickets t WHERE strpos(row_to_json(t)::text,'blocked-triage-sentinel')>0`),'0');
console.log('GEN triage verified: explicit fallback, dual catalog visibility, scoped and revocable proxy, no approval impersonation, immutable original classification/SLA and concurrent audited correction');
