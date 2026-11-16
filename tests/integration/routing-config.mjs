import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1/admin/routing-config';
const a='demo-admin-1',b='demo-admin-2';
async function request(path='',user=a,body){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user},
    body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query){
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml',
      'exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],
      {stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.on('error',reject);
    child.on('close',code=>code===0?resolve(output.trim()):reject(new Error('ROUTING_FIXTURE_SQL_FAILED')));
  });
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const propose=(body,user=a)=>request('',user,body);
const review=(item,user=b,decision='APPROVE')=>request(`/${item.id}/review`,user,
  {expectedVersion:item.version,decision,reason:'Independent review of support routing'});
const policy=(enabled=true)=>({id:randomUUID(),kind:'ASSIGNMENT_POLICY',groupId:'applications',priority:'P4',expectedPolicyId:null,
  config:enabled?{enabled:true,receiveMinutes:90,calendar:{timeZone:'Asia/Shanghai',startHour:9,endHour:18,holidays:[],workdays:[]},
    validFrom:new Date().toISOString(),validTo:new Date(Date.now()+86400000).toISOString()}:{enabled:false},reason:'CI routing policy review'});
const fallback=(groupId,target,version)=>({id:randomUUID(),kind:'FALLBACK',groupId,expectedRoutingVersion:version,
  config:{fallbackGroupId:target},reason:'CI fallback review'});
const list=async()=>{const result=await request();assert.equal(result.status,200,JSON.stringify(result));return result.data;};
const proposeOk=async body=>{const result=await propose(body);assert.equal(result.status,201,JSON.stringify(result));return result.data;};
const reviewOk=async item=>{const result=await review(item);assert.equal(result.status,200,JSON.stringify(result));return result.data;};

assert.equal((await request('','employee-1')).status,404);
assert.equal((await propose(policy(),'employee-1')).status,404);
let input=policy();
assert.equal((await propose({...input,config:{...input.config,receiveMinutes:0}})).status,400);
assert.equal((await propose({...input,reason:'password=blocked-routing-sentinel'})).status,403);
let item=await proposeOk(input);
assert.equal(item.status,'PENDING');
assert.equal((await review(item,a)).status,403,'a proposer cannot approve their own change');
assert.equal((await propose(input)).data.id,item.id,'exact retry is idempotent');
assert.equal((await propose({...input,reason:'Changed reason'})).status,409);
assert.equal((await propose(policy())).status,409,'one pending proposal per group and priority');
assert.equal(await sql("SELECT count(*) FROM assignment_policy_versions WHERE group_id='applications' AND priority='P4' AND active"),'0');
item=await reviewOk(item);
assert.equal(item.status,'APPROVED');
assert.equal((await review(item)).status,409);
const first=(await list()).policies.find(p=>p.groupId==='applications'&&p.priority==='P4');
assert.equal(first.receiveMinutes,90);
assert.equal(await sql(`SELECT count(*) FROM routing_config_audits WHERE proposal_id=${quote(item.id)}`),'2');
assert.deepEqual((await request(`/${item.id}/history`)).data.items.map(e=>e.action),['PROPOSED','APPROVED']);

input={...policy(false),expectedPolicyId:first.id};
item=await proposeOk(input);
assert.equal((await list()).policies.some(p=>p.id===first.id),true,'pending disable does not take effect');
await reviewOk(item);
assert.equal((await list()).policies.some(p=>p.id===first.id),false,'approval disables the active policy');

let data=await list();
const desk=data.groups.find(g=>g.id==='service-desk'),apps=data.groups.find(g=>g.id==='applications');
item=await proposeOk(fallback(desk.id,apps.id,desk.routingVersion));
assert.equal((await list()).groups.find(g=>g.id===desk.id).fallbackGroupId,desk.fallbackGroupId);
await reviewOk(item);
assert.equal((await list()).groups.find(g=>g.id===desk.id).fallbackGroupId,apps.id);
item=await proposeOk(fallback(apps.id,desk.id,apps.routingVersion));
assert.equal((await review(item)).status,400,'a fallback cycle is denied');
const rejected=await review(item,b,'REJECT');assert.equal(rejected.status,200);
assert.equal(rejected.data.status,'REJECTED');
item=await proposeOk(fallback(desk.id,null,desk.routingVersion+1));
await reviewOk(item);
assert.equal((await list()).groups.find(g=>g.id===desk.id).fallbackGroupId,null);
assert.equal(await sql("SELECT count(*) FROM routing_config_proposals WHERE status='PENDING'"),'0');
console.log('Routing configuration verified: scope, replay, independent review, policy activation/disable, fallback cycle, versions and audit');
