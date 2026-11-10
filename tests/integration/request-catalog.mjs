import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='agent-1',body,key=randomUUID()) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
}
async function sql(query,{success=true}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
      '-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],
    {stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.resume();child.on('error',reject);
    child.on('close',code=>success&&code!==0?reject(new Error('REQUEST_CATALOG_SQL_FAILED')):resolve({code,text:output.trim()}));
  });
}
const value=async query=>(await sql(query)).text;
const path='/request-catalog/REQ-PERM';
const publish={contentClass:'GENERAL',expectedVersion:1,name:'业务系统权限申请',description:'新开或扩展既有业务系统权限',
  maxValidityDays:90,
  groupId:'service-desk',visibleGroups:[],fields:[
    {key:'system',label:'目标系统',required:true,options:['ERP','WMS']},
    {key:'role',label:'申请角色',required:true},
    {key:'reason',label:'用途',required:true},
    {key:'expiresAt',label:'截止时间',required:true}],
  approval:{templateId:'CI-ONLY-TEMPLATE',steps:[{role:'MANAGER'},{role:'SYSTEM_OWNER',approverId:'agent-2'}]}};
const before=await value("SELECT count(*) FROM tickets WHERE service_code='REQ-PERM'");
assert.equal((await request(`${path}/versions`,'employee-1')).status,403);
assert.equal((await request(`${path}/versions`,'employee-1',publish)).status,403);
assert.equal((await request(`${path}/versions`,'agent-1',publish)).status,403,'support-group membership does not appoint a publisher');
await sql("INSERT INTO request_catalog_publishers(employee_id,service_code) VALUES ('agent-1','REQ-PERM')");
assert.equal((await request(`${path}/versions`,'agent-1')).data.currentVersion,1);
assert.equal((await request(`${path}/versions`,'agent-1',{...publish,approval:{...publish.approval,steps:[]}})).status,400);
assert.equal((await request(`${path}/versions`,'agent-1',{...publish,maxValidityDays:0})).status,400);
assert.equal((await request(`${path}/versions`,'agent-1',{...publish,approval:{...publish.approval,steps:[{role:'SYSTEM_OWNER',approverId:'disabled-person'}]}})).status,400);
assert.equal((await request(`${path}/versions`,'agent-1',{...publish,fields:[{key:'system',label:'System',required:true},{key:'system',label:'Duplicate',required:false}]})).status,400);
assert.equal((await request(`${path}/versions`,'agent-1',{...publish,description:'password: blocked-catalog-sentinel'})).status,403);
assert.equal(await value("SELECT count(*) FROM request_catalog_versions WHERE service_code='REQ-PERM'"),'0');

const key=randomUUID();
const created=await request(`${path}/versions`,'agent-1',publish,key);
assert.equal(created.status,201,JSON.stringify(created));
assert.deepEqual(created.data,{code:'REQ-PERM',formVersion:2,published:true,available:false});
assert.deepEqual((await request(`${path}/versions`,'agent-1',publish,key)).data,created.data);
assert.equal((await request(`${path}/versions`,'agent-1',{...publish,name:'Changed'},key)).status,409);
assert.equal((await request(`${path}/versions`,'agent-1',publish)).status,409,'stale form versions cannot overwrite current policy');
const revisions=await request(`${path}/versions`,'agent-1');
assert.equal(revisions.data.items.length,2);
assert.equal(revisions.data.items[0].snapshot.approval.steps[1].approverId,'agent-2');
assert.equal(revisions.data.items[0].snapshot.maxValidityDays,90);
assert.equal(revisions.data.items[1].snapshot.formVersion,1);
assert.equal(await value("SELECT required_fields::text FROM service_catalog WHERE code='REQ-PERM'"),'["system", "role", "reason", "expiresAt"]');
const catalog=await request('/catalog','employee-1');
assert.equal(catalog.data.items.find(item=>item.code==='REQ-PERM')?.available,false);
assert.equal(catalog.data.items.find(item=>item.code==='REQ-PERM')?.formVersion,2);
const attempt={contentClass:'GENERAL',serviceCode:'REQ-PERM',formVersion:2,subject:'Request more access',description:'Need WMS role',
  impact:'INDIVIDUAL',urgency:'LOW',fields:{system:'WMS',role:'Reader',reason:'Daily work',expiresAt:'2027-01-01'}};
assert.equal((await request('/tickets','employee-1',attempt)).status,503,'configured matrix cannot bypass missing OA workflow');
assert.equal(await value("SELECT count(*) FROM tickets WHERE service_code='REQ-PERM'"),before);

const unpublish={contentClass:'GENERAL',expectedVersion:2,reason:'Owner withdrew this catalog item'};
const downKey=randomUUID(),down=await request(`${path}/unpublish`,'agent-1',unpublish,downKey);
assert.equal(down.status,200,JSON.stringify(down));
assert.deepEqual((await request(`${path}/unpublish`,'agent-1',unpublish,downKey)).data,down.data);
assert.equal((await request(`${path}/unpublish`,'agent-1',unpublish)).status,409);
assert.equal((await request('/catalog','employee-1')).data.items.some(item=>item.code==='REQ-PERM'),false);
assert.equal((await request(`${path}/versions`,'agent-1')).data.items.length,2);
assert.notEqual((await sql("UPDATE request_catalog_versions SET snapshot='{}' WHERE service_code='REQ-PERM' AND form_version=2",{success:false})).code,0);
assert.equal(await value("SELECT count(*) FROM request_catalog_audits WHERE service_code='REQ-PERM'"),'2');
assert.equal(await value("SELECT count(*) FROM request_catalog_audits WHERE service_code='REQ-PERM' AND before_value ? 'approval' AND after_value ? 'approval'"),'2');
assert.equal(await value("SELECT count(*) FROM request_catalog_audits WHERE strpos(after_value::text,'blocked-catalog-sentinel')>0"),'0');
const republished=await request(`${path}/versions`,'agent-1',{...publish,expectedVersion:2,name:'业务系统权限申请（二版）'});
assert.equal(republished.status,201,JSON.stringify(republished));
assert.equal(republished.data.formVersion,3);
assert.equal(await value("SELECT before_value->>'published' FROM request_catalog_audits WHERE service_code='REQ-PERM' AND action='PUBLISH' AND after_value->>'formVersion'='3'"),'false');
assert.equal((await request(`${path}/versions`,'agent-1')).data.items[1].snapshot.published,true,'historical publication is immutable');
assert.notEqual((await sql("DELETE FROM request_catalog_versions WHERE service_code='REQ-PERM' AND form_version=2",{success:false})).code,0);
console.log('REQ catalog verified: explicit publisher, immutable revisions, matrix validation, replay, withdrawal and fail-closed OA boundary');
