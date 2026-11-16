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
const group=`support-${randomUUID()}`,one=`member-${randomUUID()}`,two=`member-${randomUUID()}`;
const version=async()=>(await ok(request())).groups.find(g=>g.id===group).version;
const propose=(kind,expectedGroupVersion,extra={})=>request('','demo-admin-1',{id:randomUUID(),kind,groupId:group,expectedGroupVersion,config:{},reason:'CI support maintenance',...extra});
const review=(p,user='demo-admin-2',decision='APPROVE')=>request(`/${p.id}/review`,user,{expectedVersion:p.version,decision,reason:'Independent support review'});
await sql(`INSERT INTO employees(id,display_name) VALUES(${quote(one)},'Support member one'),(${quote(two)},'Support member two')`);
assert.equal((await request('','employee-1')).status,404);
let p=await ok(propose('GROUP_CREATE',null,{config:{name:'自定义研发支持组',description:'CI fixture'}}));
assert.equal((await review(p,'demo-admin-1')).status,403);
await ok(review(p));
p=await ok(propose('MEMBER_ADD',await version(),{employeeId:one}));await ok(review(p));
assert.equal((await ok(request(`/groups/${group}/members`))).items.some(e=>e.id===one),true);
p=await ok(propose('MEMBER_REMOVE',await version(),{employeeId:one}));
assert.equal((await review(p)).data.code,'SUPPORT_MEMBER_CONTINUITY_REQUIRED');
await ok(review(p,'demo-admin-2','REJECT'));
p=await ok(propose('MEMBER_ADD',await version(),{employeeId:two}));await ok(review(p));
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
console.log('Support maintenance verified: independent group/member review, scoped privilege revocation, continuity and audit');
