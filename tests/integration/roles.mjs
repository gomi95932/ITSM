import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
const prefix=['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml'];
async function compose(args){
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',[...prefix,...args],{stdio:['ignore','pipe','pipe']});
    let text='';child.stdout.on('data',chunk=>{text+=chunk;});child.stderr.on('data',()=>{});
    child.on('error',reject);child.on('close',code=>resolve({code,text:text.trim()}));
  });
}
async function sql(query,database='itsm'){
  const result=await compose(['exec','-T','db','sh','-ec',
    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d "$1" -Atc "$2"','sh',database,query]);
  assert.equal(result.code,0,'ROLE_FIXTURE_SQL_FAILED');return result.text;
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
async function request(path,user='demo-admin-1',body,key=randomUUID(),headers={}){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,
    'Idempotency-Key':key,...headers},body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
const a='demo-admin-1',b='demo-admin-2',subject='role-subject',lead='role-lead',peer='role-peer',third='role-third-admin',outsider='role-outsider';
await sql(`INSERT INTO employees(id,display_name) VALUES
  ('${subject}','Role subject'),('${lead}','Role lead'),('${peer}','Role peer'),('${third}','Third admin'),('${outsider}','Role outsider');
  INSERT INTO group_memberships(employee_id,group_id) VALUES
  ('${subject}','service-desk'),('${subject}','applications'),('${lead}','service-desk'),('${peer}','service-desk'),('${third}','service-desk');`);
const proposal=(employeeId=subject,roleCode='DISPATCHER',groupId='service-desk')=>({id:randomUUID(),employeeId,roleCode,groupId,
  validFrom:new Date(Date.now()-1000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),reason:'CI reviewed appointment'});
const propose=(body,user=a)=>request('/admin/role-bindings',user,body);
const decide=(binding,user=b,decision='APPROVE',extra={})=>request(`/admin/role-bindings/${binding.id}/review`,user,
  {expectedVersion:binding.version,reason:'Independent fixture review',decision,...extra});
const revoke=(binding,user=b,extra={})=>request(`/admin/role-bindings/${binding.id}/revoke`,user,
  {expectedVersion:binding.version,reason:'Fixture appointment ended',...extra});
async function approved(input){
  const pending=await propose(input);assert.equal(pending.status,201,JSON.stringify(pending));
  const result=await decide(pending.data);assert.equal(result.status,200,JSON.stringify(result));return result.data;
}
async function create(){
  const result=await request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:`Role dispatch ${randomUUID()}`,
    description:'Ordinary WMS support request',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}});
  assert.equal(result.status,201,JSON.stringify(result));return result.data;
}
const action=(t,user,name,extra={},key,headers)=>request(`/tickets/${t.id}/actions`,user,
  {action:name,expectedVersion:t.version,...extra},key,headers);
const dispatch={targetGroupId:'applications',targetAssigneeId:'agent-2',reason:'Application specialist requested'};
const original=await create();
assert.equal((await request('/admin/role-bindings',subject)).status,404);
assert.equal((await request('/auth/me',subject)).data.canManageRoles,false);
assert.equal((await action(original,subject,'REASSIGN',dispatch)).status,403,'group membership is not dispatch authority');
assert.equal((await request(`/tickets/${original.id}`,a)).status,200,'platform admin can inspect a ticket before assigning it');
assert.equal((await request('/tickets?mine=false',a)).status,200,'platform admin can inspect the assignment queue');
assert.equal((await request(`/tickets/${original.id}`,outsider)).status,404,'ordinary member cannot read another group ticket');
assert.equal((await propose(proposal(a,'PLATFORM_ADMIN',null))).status,403,'self-grant denied');
assert.equal((await propose({...proposal(),reason:'password=blocked-role-sentinel'})).status,403);
assert.equal((await propose({...proposal(),validTo:new Date(Date.now()+400*86400000).toISOString()})).status,400);
assert.equal((await propose(proposal('employee-2'))).status,400,'group role requires membership');
assert.equal((await propose({...proposal(),canReview:true})).status,400,'overposting denied');
const body=proposal();let result=await propose(body);assert.equal(result.status,201);let binding=result.data;
assert.equal(binding.status,'PENDING');assert.equal(binding.effective,false);
assert.deepEqual((await propose(body)).data,binding,'proposal replay returns the original record');
assert.equal((await propose({...body,reason:'Changed request'})).status,409);
assert.equal((await propose(proposal())).status,409,'duplicate open binding denied');
assert.equal((await decide(binding,a)).status,403,'proposer cannot review');
assert.equal((await action(original,subject,'REASSIGN',dispatch)).status,403,'pending grant has no authority');
const reviews=await Promise.all([decide(binding),decide(binding)]);
assert.deepEqual(reviews.map(r=>r.status).sort(),[200,409]);binding=reviews.find(r=>r.status===200).data;
assert.equal(binding.effective,true);assert.equal((await revoke({...binding,version:1})).status,409);
const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
await sql(`INSERT INTO auth_sessions(token_hash,csrf_token,employee_id,expires_at) VALUES
  (${quote(createHash('sha256').update(token).digest('hex'))},${quote(csrf)},${quote(subject)},now()+interval '1 hour')`);
const session={Cookie:`itsm_session=${token}`,'X-CSRF-Token':csrf};
const classifyBody={expectedVersion:original.version,serviceCode:'INC-PC',formVersion:1,fields:{},reason:'Verified workstation issue'};
const classificationKey=randomUUID();result=await request(`/tickets/${original.id}/classification`,subject,classifyBody,classificationKey,session);
assert.equal(result.status,200,JSON.stringify(result));
const queued=await create(),key=randomUUID();
// Delivery receipts may independently record a first response; handover must preserve the SLA contract.
const slaContract=()=>sql(`SELECT json_build_object('cycle',cycle,'priority',priority,'calendar',calendar_snapshot,
  'startedAt',started_at,'responseTarget',response_target,'resolutionTarget',resolution_target,
  'completedAt',completed_at,'pausedAt',paused_at,'pausedMinutes',paused_minutes)::text
  FROM sla_cycles WHERE ticket_id=${quote(queued.id)} ORDER BY cycle`);
const sla=await slaContract();
result=await action(queued,subject,'REASSIGN',dispatch,key,session);assert.equal(result.status,200,JSON.stringify(result));const offered=result.data;
assert.equal(offered.assigneeId,null);assert.equal(offered.status,'QUEUED');
assert.equal(await sql(`SELECT owner_group_id FROM tickets WHERE id=${quote(queued.id)}`),'service-desk');
assert.deepEqual((await action(queued,subject,'REASSIGN',dispatch,key,session)).data,offered);
result=await revoke(binding);assert.equal(result.status,200,JSON.stringify(result));binding=result.data;
assert.equal(binding.effective,false);
assert.equal((await action(queued,subject,'REASSIGN',dispatch,key,session)).status,403,'old session and idempotency replay recheck current roles');
assert.equal((await request(`/tickets/${original.id}/classification`,subject,classifyBody,classificationKey,session)).status,403);
assert.equal((await action(offered,subject,'CANCEL_HANDOVER',{reason:'No longer authorized'},undefined,session)).status,403);
assert.equal((await request(`/tickets/${offered.id}`,subject)).data.canDispatchQueued,false);
result=await action(offered,'agent-2','ACCEPT_HANDOVER',{comment:'Application engineer accepts'});assert.equal(result.status,200,JSON.stringify(result));
assert.equal(result.data.assigneeId,'agent-2');assert.equal(result.data.status,'IN_PROGRESS');
assert.equal(await slaContract(),sla,'role changes and transfer preserve SLA deadlines, calendar and cycle');
assert.deepEqual((await request(`/admin/role-bindings/${binding.id}/history`)).data.items.map(i=>i.action),['PROPOSED','APPROVED','REVOKED']);
assert.equal(await sql(`SELECT count(*) FROM role_binding_audits WHERE binding_id=${quote(binding.id)}`),'3');
assert.equal(await sql(`SELECT count(*) FROM role_bindings r WHERE strpos(row_to_json(r)::text,'blocked-role-sentinel')>0`),'0');
// A group lead can propose only for its own groups and cannot approve any appointment.
const leadBinding=await approved(proposal(lead,'GROUP_LEAD'));
assert.equal((await request('/auth/me',lead)).data.canManageRoles,true);
const options=(await request(`/admin/role-bindings/options?q=${subject}`,lead)).data;
assert.deepEqual(options.groups.map(g=>g.id),['service-desk']);assert.deepEqual(options.people.find(p=>p.id===subject).groups,['service-desk']);
assert.equal(options.roleCodes.includes('PLATFORM_ADMIN'),false);
assert.equal((await propose(proposal(subject,'DISPATCHER','applications'),lead)).status,404);
assert.equal((await propose(proposal(peer,'PLATFORM_ADMIN',null),lead)).status,404);
result=await propose(proposal(peer),lead);assert.equal(result.status,201);const leadProposal=result.data;
assert.equal((await decide(leadProposal,lead)).status,404);assert.equal((await revoke(leadBinding,lead)).status,404);
assert.equal((await decide(leadProposal,b,'REJECT')).status,200);
assert.equal((await revoke(leadProposal)).status,409);
// Keep two effective administrators during ordinary revocation. Personnel emergency disable is separate.
const adminBinding=(await request('/admin/role-bindings')).data.items.find(r=>r.employeeId===a&&r.roleCode==='PLATFORM_ADMIN');
assert.equal((await revoke(adminBinding)).status,409);
const thirdBinding=await approved(proposal(third,'PLATFORM_ADMIN',null));
result=await propose(proposal(third,'GROUP_LEAD'));assert.equal(result.status,201);
assert.equal((await decide(result.data,third)).status,403,'subject cannot review even with platform authority');
assert.equal((await decide(result.data,b,'REJECT')).status,200);
assert.equal((await revoke(thirdBinding)).status,200);
// Time, membership and employee state are checked on every request, not frozen into sessions.
let changing=await approved(proposal());
await sql(`UPDATE role_bindings SET valid_from=now()-interval '2 hours',valid_to=now()-interval '1 hour' WHERE id=${quote(changing.id)}`);
assert.equal((await action(await create(),subject,'REASSIGN',dispatch)).status,403);
assert.equal((await revoke(changing)).status,200);changing=await approved(proposal());
await sql(`UPDATE role_bindings SET valid_from=now()+interval '1 hour' WHERE id=${quote(changing.id)}`);
assert.equal((await action(await create(),subject,'REASSIGN',dispatch)).status,403);
await sql(`UPDATE role_bindings SET valid_from=now()-interval '1 minute' WHERE id=${quote(changing.id)};
  DELETE FROM group_memberships WHERE employee_id=${quote(subject)} AND group_id='service-desk'`);
assert.equal((await request(`/tickets/${original.id}`,subject)).status,404);
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(subject)},'service-desk');
  UPDATE employees SET active=false WHERE id=${quote(subject)}`);
assert.equal((await action(await create(),subject,'REASSIGN',dispatch,undefined,session)).status,401);
await sql(`UPDATE employees SET active=true WHERE id=${quote(subject)}`);
assert.equal((await revoke(changing)).status,200);
const unavailable=await propose(proposal());assert.equal(unavailable.status,201);
await sql(`DELETE FROM group_memberships WHERE employee_id=${quote(subject)} AND group_id='service-desk'`);
assert.equal((await decide(unavailable.data)).status,400,'approval rechecks membership');
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(subject)},'service-desk');
  UPDATE employees SET active=false WHERE id=${quote(subject)}`);
assert.equal((await decide(unavailable.data)).status,400,'approval rechecks active employment');
await sql(`UPDATE employees SET active=true WHERE id=${quote(subject)}`);assert.equal((await revoke(unavailable.data)).status,200);
await revoke(leadBinding);
// Test bootstrap only in a separate empty CI database; never clear the application's role table.
const database=`itsm_roles_${randomUUID().replaceAll('-','')}`;
await sql(`CREATE DATABASE ${database}`);
try{
  const migrate=await compose(['exec','-T','-e',`DB_NAME=${database}`,'-e','ITSM_SEED_DEV_DATA=false','api','node','scripts/migrate.mjs']);
  assert.equal(migrate.code,0,'isolated bootstrap migrations');
  await sql("INSERT INTO employees(id,display_name) VALUES ('bootstrap-first','First'),('bootstrap-second','Second')",database);
  const args=['exec','-T','-e',`DB_NAME=${database}`,'api','node','apps/api/dist/bootstrap-role-admins.js',
    '--first','bootstrap-first','--second','bootstrap-second','--reason','Approved CI bootstrap'];
  assert.notEqual((await compose(args)).code,0,'bootstrap requires explicit confirmation');
  const confirmed=[...args];confirmed.splice(4,0,'-e','ITSM_ROLE_BOOTSTRAP_CONFIRM=INITIAL_TWO_ADMINS');
  const first=await compose(confirmed);assert.equal(first.code,0,first.text);
  assert.equal(JSON.parse(first.text).grants.length,2);
  assert.equal(await sql("SELECT count(*) FROM role_binding_audits WHERE action='BOOTSTRAPPED'",database),'2');
  assert.notEqual((await compose(confirmed)).code,0,'bootstrap cannot be reused');
}finally{await sql(`DROP DATABASE ${database} WITH (FORCE)`);}
console.log('Roles verified: scoped proposal, independent review, live session revocation, candidate handover, preserved SLA, audit and one-time two-admin bootstrap');
