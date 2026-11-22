import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1',path='/admin/support-structure';
async function request(url,user='demo-admin-1',body){
  const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':randomUUID()},
    body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query,success=true){
  const failure=new Error('LIFECYCLE_FIXTURE_SQL_FAILED');
  return new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
  let output='',diagnostic='';child.stdout.on('data',chunk=>output+=chunk);
  child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-4096);});child.once('error',reject);
  child.once('close',code=>{
    if(!success)return resolve(code);
    if(code===0)return resolve(output.trim());
    const errorLine=diagnostic.match(/^ERROR:.*$/m)?.[0];
    failure.message+=errorLine?`: ${errorLine}`:` (exit ${code})`;
    reject(failure);
  });
});}
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const ok=async promise=>{const r=await promise;assert.ok([200,201].includes(r.status),JSON.stringify(r));return r.data;};
const suffix=randomUUID(),group=`retire-${suffix}`,peer=`peer-${suffix}`,member=`member-${suffix}`,code=`LIFE-${suffix}`;
const groupView=async()=> (await ok(request(path))).groups.find(row=>row.id===group);
const dependencies=()=>ok(request(`${path}/groups/${group}/dependencies`));
const proposal=async(kind,extra={})=>request(path,'demo-admin-1',{id:randomUUID(),kind,groupId:group,config:{},
  expectedGroupVersion:(await groupView()).version,reason:'CI lifecycle configuration',...extra});
const review=(item,decision='APPROVE',user='demo-admin-2')=>request(`${path}/${item.id}/review`,user,{expectedVersion:item.version,decision,reason:'Independent lifecycle review'});
async function observedReview(item){
  const diagnostic=await readFile('tests/support/database-waits.sql','utf8');
  const samples=[];
  let done=false;
  const monitor=(async()=>{
    while(!done){
      try{samples.push(JSON.parse(await sql(diagnostic)));}catch{samples.push({diagnosticUnavailable:true});}
      if(!done)await new Promise(resolve=>setTimeout(resolve,250));
    }
  })();
  let result;
  try{result=await review(item);return result;}finally{
    done=true;await monitor;
    await mkdir('test-results',{recursive:true});
    await writeFile('test-results/support-retirement-waits.json',JSON.stringify({result,samples},null,2));
  }
}
await sql(`INSERT INTO support_groups(id,name) VALUES(${q(group)},'Lifecycle fixture'),(${q(peer)},'Lifecycle peer');
  INSERT INTO employees(id,display_name) VALUES(${q(member)},'Lifecycle engineer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES(${q(member)},${q(group)});
  INSERT INTO priority_reviewers(employee_id,group_id) VALUES(${q(member)},${q(group)});
  INSERT INTO knowledge_editors(employee_id,group_id) VALUES(${q(member)},${q(group)});
  INSERT INTO knowledge_reviewers(employee_id,group_id) VALUES(${q(member)},${q(group)});
  INSERT INTO service_catalog(code,type,form_version,group_id,name) VALUES(${q(code)},'INC',1,${q(group)},'Lifecycle catalog');
  INSERT INTO request_catalog_publishers(employee_id,service_code) VALUES(${q(member)},${q(code)});`);
const binding=randomUUID();
await sql(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,status,valid_from,valid_to,requested_by,reviewed_by,reviewed_at,reason,review_reason)
  VALUES(${q(binding)},${q(member)},'GROUP_LEAD',${q(group)},'ACTIVE',now()-interval '1 hour',now()+interval '1 day','demo-admin-1','demo-admin-2',now(),'CI lifecycle','Independent review');`);
assert.equal((await request(`${path}/groups/${group}/dependencies`,'employee-1')).status,404);
assert.equal((await request(`${path}/groups/${group}/dependencies`,member)).status,404);
assert.equal((await request(path,member,{id:randomUUID(),kind:'GROUP_DISABLE',groupId:group,config:{},expectedGroupVersion:1,reason:'Out of scope'})).status,404);
assert.equal((await dependencies()).total,0,'members and scoped rights are explicitly revoked, not blocking business dependencies');

// Dependency checks are current at approval, not just at proposal creation.
const retiring=await ok(proposal('GROUP_DISABLE'));
assert.equal((await review(retiring,'APPROVE','demo-admin-1')).status,403);
await sql(`UPDATE service_catalog SET published=true WHERE code=${q(code)}`);
assert.ok((await dependencies()).items.some(item=>item.kind==='CATALOG'));
const blockedRetirement=await observedReview(retiring);
assert.equal(blockedRetirement.status,409,JSON.stringify(blockedRetirement));
assert.equal(blockedRetirement.data.code,'SUPPORT_GROUP_DEPENDENCIES');
assert.equal((await groupView()).enabled,true);
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id=${q(binding)}`),'ACTIVE','failed retirement is atomic');
await sql(`UPDATE service_catalog SET published=false WHERE code=${q(code)};
  UPDATE support_groups SET fallback_group_id=${q(group)} WHERE id=${q(peer)};`);
assert.ok((await dependencies()).items.some(item=>item.kind==='FALLBACK'));
assert.equal((await proposal('GROUP_DISABLE')).data.code,'SUPPORT_GROUP_DEPENDENCIES');
await sql(`UPDATE support_groups SET fallback_group_id=NULL WHERE id=${q(peer)};
  UPDATE support_groups SET fallback_group_id=${q(peer)} WHERE id=${q(group)};`);
assert.ok((await dependencies()).items.some(item=>item.kind==='FALLBACK'));
await sql(`UPDATE support_groups SET fallback_group_id=NULL WHERE id=${q(group)};
  INSERT INTO assignment_policy_versions(group_id,priority,receive_minutes,calendar_snapshot,valid_from,valid_to,proposed_by,approved_by,approved_at,active)
    VALUES(${q(group)},'P3',30,'{}',now()-interval '1 hour',now()+interval '1 day','demo-admin-1','demo-admin-2',now(),true);`);
assert.ok((await dependencies()).items.some(item=>item.kind==='ASSIGNMENT_POLICY'));
await sql(`UPDATE assignment_policy_versions SET active=false WHERE group_id=${q(group)}`);

const ticket=randomUUID(),knowledge=randomUUID();
await sql(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,subject,description,fields,impact,urgency,priority,status)
  VALUES(${q(ticket)},${q(`LIFE-${suffix}`)},'employee-1','employee-1',${q(group)},${q(code)},'INC',1,'Lifecycle fixture','Synthetic fixture','{}','INDIVIDUAL','LOW','P4','REGISTERED');
  INSERT INTO knowledge_articles(id,owner_group_id,author_id,title,body,audience,review_due_at)
    VALUES(${q(knowledge)},${q(group)},${q(member)},'Lifecycle knowledge','Synthetic fixture','SUPPORT_GROUP',now()+interval '1 day');`);
assert.ok((await dependencies()).items.some(item=>item.kind==='TICKET'));
assert.ok((await dependencies()).items.some(item=>item.kind==='KNOWLEDGE'));
await sql(`UPDATE tickets SET status='CLOSED' WHERE id=${q(ticket)}; UPDATE knowledge_articles SET status='ARCHIVED' WHERE id=${q(knowledge)}`);
const historical=await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${q(ticket)}`);
const reqTicket=randomUUID(),approval=randomUUID(),fulfillment=randomUUID();
await sql(`INSERT INTO service_catalog(code,type,form_version,group_id,name) VALUES(${q(code+'-req')},'REQ',1,${q(group)},'Lifecycle request');
  INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,subject,description,fields,impact,urgency,priority,status)
    VALUES(${q(reqTicket)},${q('REQ-'+suffix)},'employee-1','employee-1',${q(group)},${q(code+'-req')},'REQ',1,'Lifecycle request','Synthetic fixture','{}','INDIVIDUAL','LOW','P4','CLOSED');
  INSERT INTO request_approvals(id,ticket_id,corp_id,snapshot,expires_at,state)
    VALUES(${q(approval)},${q(reqTicket)},'ci-lifecycle','{}',now()+interval '1 day','BLOCKED');
  INSERT INTO request_fulfillments(id,approval_id,ticket_id,assignee_id,ready_until,state,delivered_at,access_expires_at)
    VALUES(${q(fulfillment)},${q(approval)},${q(reqTicket)},${q(member)},now()+interval '1 day','REVOKE_DUE',now(),now()+interval '1 day');`);
assert.ok((await dependencies()).items.some(item=>item.kind==='FULFILLMENT'),'closed tickets can still have unresolved entitlements');
await sql(`UPDATE request_fulfillments SET state='REVOKED',revoked_at=now() WHERE id=${q(fulfillment)}`);
const queuedCount=await sql(`BEGIN; UPDATE request_approvals SET state='QUEUED' WHERE id=${q(approval)};
  SELECT count(*) FROM support_group_dependencies(${q(group)}) WHERE kind='APPROVAL'; ROLLBACK;`);
assert.ok(queuedCount.split('\n').includes('1'));

// Enabled positions and appointments must be resolved by the reviewed organization editor.
let structure=await ok(request('/admin/service-structure'));
const config=structuredClone(structure.config),domain=`lifecycle-${suffix}`,position=`position-${suffix}`,appointment=randomUUID();
config.domains.push({id:domain,name:`Lifecycle ${suffix}`,enabled:true});
config.positions.push({id:position,name:`Lifecycle position ${suffix}`,domainId:domain,groupId:group,enabled:true});
config.appointments.push({id:appointment,positionId:position,employeeId:member,duty:'PRIMARY',enabled:true,
  validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString()});
async function publish(next){
  const current=await ok(request('/admin/service-structure'));
  const p=await ok(request('/admin/service-structure','demo-admin-1',{id:randomUUID(),expectedVersion:current.version,config:next,reason:'Lifecycle organization fixture'}));
  await ok(request(`/admin/service-structure/${p.id}/review`,'demo-admin-2',{expectedVersion:p.version,decision:'APPROVE',reason:'Independent organization review'}));
}
await publish(config);
const deps=await dependencies();
for(const kind of ['POSITION','APPOINTMENT'])assert.ok(deps.items.some(item=>item.kind===kind));
config.positions.find(row=>row.id===position).enabled=false;
config.appointments.find(row=>row.id===appointment).enabled=false;
await publish(config);

// A pending routing proposal cannot be approved after retirement, but can still be rejected.
const routing=await ok(request('/admin/routing-config','demo-admin-1',{id:randomUUID(),kind:'FALLBACK',groupId:group,
  config:{fallbackGroupId:peer},expectedRoutingVersion:1,reason:'Pending route before retirement'}));
assert.equal((await dependencies()).total,0);
await ok(review(retiring));
assert.equal((await groupView()).enabled,false);
assert.equal((await groupView()).activeMembers,0);
for(const table of ['group_memberships','priority_reviewers','knowledge_editors','knowledge_reviewers'])
  assert.equal(await sql(`SELECT count(*) FROM ${table} WHERE group_id=${q(group)}`),'0');
assert.equal(await sql(`SELECT count(*) FROM request_catalog_publishers WHERE service_code=${q(code)}`),'0');
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id=${q(binding)}`),'REVOKED');
assert.equal(await sql(`SELECT count(*) FROM role_binding_audits WHERE binding_id=${q(binding)} AND action='REVOKED'`),'1');
assert.equal(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${q(ticket)}`),historical,'history and SLA columns remain unchanged');
assert.equal((await proposal('MEMBER_ADD',{employeeId:member})).data.code,'SUPPORT_GROUP_DISABLED');
assert.equal((await request(`/admin/routing-config/${routing.id}/review`,'demo-admin-2',{
  expectedVersion:routing.version,decision:'APPROVE',reason:'Must reject inactive source'})).data.code,'ROUTING_GROUP_UNAVAILABLE');
await ok(request(`/admin/routing-config/${routing.id}/review`,'demo-admin-2',{expectedVersion:routing.version,decision:'REJECT',reason:'Retired group'}));
assert.equal((await ok(request('/support-groups','agent-1'))).items.some(row=>row.id===group),false);
assert.equal((await ok(request('/admin/service-structure'))).options.groups.find(row=>row.id===group).enabled,false);
const invalid=structuredClone(config);invalid.positions.find(row=>row.id===position).enabled=true;
structure=await ok(request('/admin/service-structure'));
assert.equal((await request('/admin/service-structure/preview','demo-admin-1',{id:randomUUID(),expectedVersion:structure.version,
  config:invalid,reason:'Must not reactivate position in inactive group'})).data.code,'SERVICE_STRUCTURE_GROUP_UNAVAILABLE');
await publish(config); // Archived references remain editable without resurrecting the group.
for(const query of [
  `INSERT INTO group_memberships(employee_id,group_id) VALUES(${q(member)},${q(group)})`,
  `UPDATE service_catalog SET published=true WHERE code=${q(code)}`,
  `UPDATE support_groups SET fallback_group_id=${q(group)} WHERE id=${q(peer)}`,
  `UPDATE tickets SET status='REGISTERED' WHERE id=${q(ticket)}`,
  `UPDATE knowledge_articles SET status='DRAFT' WHERE id=${q(knowledge)}`,
  `UPDATE assignment_policy_versions SET active=true WHERE group_id=${q(group)}`,
  `UPDATE request_fulfillments SET state='READY' WHERE id=${q(fulfillment)}`,
  `UPDATE request_approvals SET state='QUEUED' WHERE id=${q(approval)}`,
])assert.notEqual(await sql(query,false),0,'database guards prevent inactive group reference revival');
const audit=await ok(request(`${path}/${retiring.id}/history`));
assert.deepEqual(audit.items.map(row=>row.action),['PROPOSED','APPROVED']);
assert.equal(audit.items[1].beforeValue.retired.members.length,1);
assert.equal(audit.items[1].afterValue.group.enabled,false);
assert.notEqual(await sql(`DELETE FROM support_structure_audits WHERE proposal_id=${q(retiring.id)}`,false),0);
const restore=await ok(proposal('GROUP_RESTORE'));await ok(review(restore));
assert.equal((await groupView()).enabled,true);
assert.equal((await groupView()).activeMembers,0,'restore never implicitly restores old membership');
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id=${q(binding)}`),'REVOKED');
assert.equal((await proposal('GROUP_RESTORE')).data.code,'SUPPORT_GROUP_STATE_CONFLICT');
console.log('Support lifecycle verified: scoped administration, dependency revalidation, atomic privilege revocation, archived references, runtime guards, immutable history and explicit restore');
