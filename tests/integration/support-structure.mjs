import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1/admin/support-structure';
async function request(path='',user='demo-admin-1',body){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user},body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query){return new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.once('error',reject);child.once('close',code=>code===0?resolve(output.trim()):reject(new Error('SUPPORT_FIXTURE_SQL_FAILED')));
});}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const ok=async promise=>{const r=await promise;assert.ok([200,201].includes(r.status),JSON.stringify(r));return r.data;};
const group=`support-${randomUUID()}`,one=`member-${randomUUID()}`,two=`member-${randomUUID()}`,lead=`leader-${randomUUID()}`;
const version=async()=>(await ok(request())).groups.find(g=>g.id===group).version;
const propose=(kind,expectedGroupVersion,extra={})=>request('','demo-admin-1',{id:randomUUID(),kind,groupId:group,expectedGroupVersion,config:{},reason:'CI support maintenance',...extra});
const review=(p,user='demo-admin-2',decision='APPROVE')=>request(`/${p.id}/review`,user,{expectedVersion:p.version,decision,reason:'Independent support review'});
await sql(`INSERT INTO employees(id,display_name) VALUES(${quote(one)},'Support member one'),(${quote(two)},'Support member two'),(${quote(lead)},'Support group lead')`);
assert.equal((await request('','employee-1')).status,404);
const admin=await ok(request());assert.equal(admin.canManageGroups,true);assert.equal(admin.canReview,true);
assert.equal((await ok(request('/people?q=Support'))).items.some(row=>row.id===one),true);
assert.equal((await ok(request('/people?q=S'))).items.length,0);
assert.equal((await ok(request('/people?q=demo-admin-1'))).items.some(row=>row.id==='demo-admin-1'),true,
  'platform administrators can select themselves for support duties');
let p=await ok(propose('GROUP_CREATE',null,{config:{name:'自定义研发支持组',description:'CI fixture'}}));
assert.equal((await review(p,'demo-admin-1')).status,403);
await ok(review(p));
p=await ok(propose('MEMBER_ADD',await version(),{employeeId:one}));await ok(review(p));
assert.equal((await ok(request(`/groups/${group}/members`))).items.some(e=>e.id===one),true);
p=await ok(propose('MEMBER_REMOVE',await version(),{employeeId:one}));
assert.equal((await review(p)).data.code,'SUPPORT_MEMBER_CONTINUITY_REQUIRED');
await ok(review(p,'demo-admin-2','REJECT'));
p=await ok(propose('MEMBER_ADD',await version(),{employeeId:two}));await ok(review(p));
assert.equal((await request(`/groups/${group}/members?page=0`)).status,400);
assert.equal((await ok(request(`/groups/${group}/members?q=one`))).total,1);
assert.equal((await ok(request(`/groups/${group}/members?page=2`))).items.length,0);
const leadBinding=randomUUID();
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES(${quote(lead)},${quote(group)});
  INSERT INTO role_bindings(id,employee_id,role_code,group_id,status,valid_from,valid_to,requested_by,reviewed_by,reviewed_at,reason,review_reason)
    VALUES(${quote(leadBinding)},${quote(lead)},'GROUP_LEAD',${quote(group)},'ACTIVE',now()-interval '1 hour',now()+interval '1 day','demo-admin-1','demo-admin-2',now(),'CI lead','CI review');`);
const scoped=await ok(request('',lead));assert.equal(scoped.canManageGroups,false);assert.equal(scoped.canReview,false);
assert.deepEqual(scoped.groups.map(row=>row.id),[group]);assert.ok(scoped.items.every(row=>row.groupId===group));
assert.equal((await request('/groups/service-desk/members',lead)).status,404);
const leadPropose=(kind,extra={})=>request('',lead,{id:randomUUID(),kind,groupId:group,expectedGroupVersion:null,config:{},reason:'Scoped lead change',...extra});
assert.equal((await leadPropose('GROUP_CREATE',{groupId:`denied-${randomUUID()}`,config:{name:'Denied',description:''}})).status,404);
assert.equal((await leadPropose('GROUP_UPDATE',{expectedGroupVersion:await version(),config:{name:'Denied',description:''}})).status,404);
assert.equal((await leadPropose('MEMBER_ADD',{expectedGroupVersion:await version(),employeeId:lead})).data.code,'SUPPORT_SELF_GRANT_DENIED');
assert.equal((await leadPropose('MEMBER_REMOVE',{groupId:'service-desk',expectedGroupVersion:1,employeeId:'agent-1'})).status,404);
let scopedProposal=await ok(leadPropose('MEMBER_REMOVE',{expectedGroupVersion:await version(),employeeId:two}));
assert.equal((await review(scopedProposal,lead)).status,404);
await ok(review(scopedProposal,'demo-admin-2','REJECT'));
assert.equal((await ok(request(`/${scopedProposal.id}/history`,lead))).items.length,2);
assert.equal((await request(`/${scopedProposal.id}/history`,'employee-1')).status,404);
const v=await version();
p=await ok(propose('GROUP_UPDATE',v,{config:{name:'研发支持组调整后',description:'Updated scope'}}));await ok(review(p));
assert.equal((await propose('MEMBER_REMOVE',v,{employeeId:two})).data.code,'SUPPORT_VERSION_CONFLICT');
const binding=randomUUID();
await sql(`INSERT INTO priority_reviewers(employee_id,group_id) VALUES(${quote(one)},${quote(group)}),(${quote(two)},${quote(group)});
  INSERT INTO knowledge_editors(employee_id,group_id) VALUES(${quote(one)},${quote(group)});
  INSERT INTO knowledge_reviewers(employee_id,group_id) VALUES(${quote(one)},${quote(group)});
  INSERT INTO role_bindings(id,employee_id,role_code,group_id,status,valid_from,valid_to,requested_by,reviewed_by,reviewed_at,reason,review_reason)
    VALUES(${quote(binding)},${quote(one)},'DISPATCHER',${quote(group)},'ACTIVE',now()-interval '1 hour',now()+interval '1 day','demo-admin-1','demo-admin-2',now(),'CI appointment','CI review');`);
p=await ok(propose('MEMBER_REMOVE',await version(),{employeeId:one}));await ok(review(p));
assert.equal(await sql(`SELECT count(*) FROM group_memberships WHERE employee_id=${quote(one)} AND group_id=${quote(group)}`),'0');
for(const table of ['priority_reviewers','knowledge_editors','knowledge_reviewers'])
  assert.equal(await sql(`SELECT count(*) FROM ${table} WHERE employee_id=${quote(one)} AND group_id=${quote(group)}`),'0');
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id=${quote(binding)}`),'REVOKED');
assert.deepEqual((await ok(request(`/${p.id}/history`))).items.map(e=>e.action),['PROPOSED','APPROVED']);
console.log('Support maintenance verified: capability responses, search/pagination, scoped group lead, independent review, version conflict, privilege revocation, continuity and audit');
