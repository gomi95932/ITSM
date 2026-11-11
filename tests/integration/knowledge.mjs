import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1/knowledge';
async function call(path,user,body,key=randomUUID(),method='POST') {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
}
async function read(path,user) { return call(path,user,undefined,undefined,'GET'); }
async function sql(query,{success=true}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
      '-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],
    {stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.on('error',reject);
    child.on('close',code=>success&&code!==0?reject(new Error(`KNOWLEDGE_SQL_FAILED: ${query}`)):resolve({code,output:output.trim()}));
  });
}

const due=new Date(Date.now()+30*86400000).toISOString().replace(/\.\d+Z$/,'Z');
const title=`WMS 工作站故障排查 ${randomUUID()}`;
const draft={contentClass:'GENERAL',groupId:'service-desk',title,body:'确认网络连通性后联系服务台。',audience:'EMPLOYEE',reviewDueAt:due};
assert.equal((await call('','employee-1',draft)).status,404,'employee cannot create');
await sql("INSERT INTO knowledge_editors VALUES ('agent-1','service-desk')");
await sql("INSERT INTO knowledge_reviewers VALUES ('agent-3','service-desk'),('agent-1','service-desk')");
assert.deepEqual((await read('/roles','agent-3')).data.groups,[{groupId:'service-desk',editor:false,reviewer:true}]);
assert.deepEqual((await read('/roles','employee-1')).data.groups,[]);
const blocked=await call('','agent-1',{...draft,title:'泄漏标记-'+randomUUID(),body:'api_key=secret1234567890'});
assert.equal(blocked.status,403);
const key=randomUUID(),created=await call('','agent-1',draft,key);
assert.equal(created.status,201,JSON.stringify(created));
const id=created.data.id;
assert.deepEqual((await call('','agent-1',draft,key)).data,created.data);
assert.equal((await call('','agent-1',{...draft,title:'another'},key)).status,409);
assert.equal((await read(`/${id}`,'employee-1')).status,404,'unpublished draft must remain private');
assert.equal((await read(`/${id}?scope=managed`,'employee-1')).status,404);
assert.equal((await read(`/${id}?scope=managed`,'agent-2')).status,404);
assert.equal((await read(`/${id}?scope=managed`,'agent-3')).data.body,draft.body);
assert.equal((await read('?search=WMS','employee-1')).data.items.some(item=>item.id===id),false);
assert.equal((await read('?search=%25','employee-1')).data.items.some(item=>item.id===id),false,'search wildcard must be literal');
assert.equal((await call(`/${id}/publish`,'agent-1',{expectedVersion:1})).status,409);
const submitted=await call(`/${id}/submit`,'agent-1',{expectedVersion:1});assert.equal(submitted.status,200);
assert.equal((await call(`/${id}/approve`,'agent-1',{expectedVersion:1})).status,409,'self approval blocked');
assert.equal((await call(`/${id}/approve`,'agent-2',{expectedVersion:1})).status,404);
assert.equal((await call(`/${id}/revise`,'agent-1',{...draft,expectedVersion:1})).status,400);
const approved=await call(`/${id}/approve`,'agent-3',{expectedVersion:1});assert.equal(approved.status,200);
const published=await call(`/${id}/publish`,'agent-1',{expectedVersion:1});assert.equal(published.status,200);
assert.equal((await read(`/${id}`,'employee-1')).data.body,draft.body);
assert.equal((await read('?search=WMS','employee-2')).data.items.some(item=>item.id===id),true);
assert.notEqual((await sql(`UPDATE knowledge_versions SET title='tamper' WHERE article_id='${id}'`,{success:false})).code,0);
assert.notEqual((await sql(`DELETE FROM knowledge_versions WHERE article_id='${id}'`,{success:false})).code,0);

const revised={contentClass:'GENERAL',expectedVersion:1,title:`更新 ${title}`,body:'重新确认应用状态。',audience:'SUPPORT_GROUP',reviewDueAt:due};
assert.equal((await call(`/${id}/revise`,'agent-1',revised)).data.draftVersion,2);
assert.equal((await read(`/${id}`,'employee-2')).data.title,title,'old publication remains until replacement');
assert.equal((await call(`/${id}/submit`,'agent-1',{expectedVersion:1})).status,409);
await call(`/${id}/submit`,'agent-1',{expectedVersion:2});
await call(`/${id}/approve`,'agent-3',{expectedVersion:2});
assert.equal((await call(`/${id}/publish`,'agent-1',{expectedVersion:2})).status,200);
assert.equal((await read(`/${id}`,'employee-2')).status,404,'group audience must be enforced');
assert.equal((await read(`/${id}`,'agent-3')).data.version,2);
assert.equal((await sql(`SELECT count(*) FROM knowledge_versions WHERE article_id='${id}'`)).output,'2');
assert.equal((await call(`/${id}/archive`,'agent-1',{expectedVersion:2})).status,200);
assert.equal((await read(`/${id}`,'agent-3')).status,404);
assert.equal((await sql(`SELECT count(*) FROM knowledge_audits WHERE article_id='${id}'`)).output,'9');
console.log('Knowledge publication, independent review, immutable versions, audience, content boundary and audit verified');
