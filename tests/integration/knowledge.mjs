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
    let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);
    child.on('close',code=>success&&code!==0?reject(new Error(`KNOWLEDGE_SQL_FAILED: ${error}`)):resolve({code,output:output.trim(),error}));
  });
}
async function rejected(query,reason) {
  const result=await sql(query,{success:false});
  assert.notEqual(result.code,0);
  assert.match(result.error,reason);
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
assert.equal((await call(`/${id}/feedback`,'employee-1',{version:1,helpful:true})).status,404,'draft feedback must remain private');
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

for(const body of [{version:1,helpful:'yes'},{version:0,helpful:true},{version:1},
  {version:1,helpful:true,employeeId:'employee-2'}])
  assert.equal((await call(`/${id}/feedback`,'employee-1',body)).status,400,'feedback accepts only version and a boolean');
assert.equal((await call(`/${id}/feedback`,'employee-1',{version:1,helpful:true},'')).status,400,'idempotency key is required');
assert.equal((await read(`/${id}`,'employee-1')).data.feedback,null);
const feedbackKey=randomUUID(),vote={version:1,helpful:true};
const feedback=await call(`/${id}/feedback`,'employee-1',vote,feedbackKey);
assert.equal(feedback.status,200,JSON.stringify(feedback));
assert.equal(feedback.data.helpful,true);
assert.deepEqual((await call(`/${id}/feedback`,'employee-1',vote,feedbackKey)).data,feedback.data,'same request replays without a second vote');
assert.equal((await call(`/${id}/feedback`,'employee-1',{...vote,helpful:false},feedbackKey)).status,409,'key reuse with different content is rejected');
assert.equal((await call(`/${id}/feedback`,'employee-1',vote)).status,409,'a fresh key cannot duplicate the same reader/version vote');
assert.equal((await read(`/${id}`,'employee-2')).data.feedback,null,'another reader cannot see the first reader vote');
assert.equal((await call(`/${id}/feedback`,'employee-2',{version:1,helpful:false})).status,200);
assert.equal((await read(`/${id}`,'employee-1')).data.feedback.helpful,true);
assert.equal((await read(`/${id}`,'employee-2')).data.feedback.helpful,false);
const concurrentReader=`knowledge-reader-${randomUUID()}`;
await sql(`INSERT INTO employees(id,display_name) VALUES ('${concurrentReader}','Knowledge feedback concurrency fixture')`);
const concurrent=await Promise.all([true,false].map(helpful=>call(`/${id}/feedback`,concurrentReader,{version:1,helpful})));
assert.deepEqual(concurrent.map(item=>item.status).sort(),[200,409],'concurrent submissions persist exactly one vote');
const winner=concurrent.find(item=>item.status===200);
const summary=(await read(`/${id}?scope=managed`,'agent-3')).data.feedbackSummary;
assert.deepEqual(summary,{version:1,total:3,helpful:1+Number(winner.data.helpful),notHelpful:1+Number(!winner.data.helpful)});
assert.equal(Object.hasOwn((await read(`/${id}`,'employee-1')).data,'feedbackSummary'),false,'ordinary readers do not receive management feedback summaries');
await rejected(`UPDATE knowledge_feedback SET helpful=false WHERE article_id='${id}'`,/KNOWLEDGE_FEEDBACK_IMMUTABLE/);
await rejected(`DELETE FROM knowledge_feedback WHERE article_id='${id}'`,/KNOWLEDGE_FEEDBACK_IMMUTABLE/);
await sql(`UPDATE employees SET active=false WHERE id='${concurrentReader}'`);
assert.equal((await call(`/${id}/feedback`,concurrentReader,vote)).status,401,'disabled employee cannot submit');

const revised={contentClass:'GENERAL',expectedVersion:1,title:`更新 ${title}`,body:'重新确认应用状态。',audience:'SUPPORT_GROUP',reviewDueAt:due};
assert.equal((await call(`/${id}/revise`,'agent-1',revised)).data.draftVersion,2);
assert.equal((await read(`/${id}`,'employee-2')).data.title,title,'old publication remains until replacement');
assert.equal((await read(`/${id}`,'employee-1')).data.feedback.helpful,true,'draft revision does not reset publication feedback');
assert.equal((await call(`/${id}/feedback`,'agent-3',{version:2,helpful:true})).status,409,'draft version cannot receive publication feedback');
assert.equal((await call(`/${id}/submit`,'agent-1',{expectedVersion:1})).status,409);
await call(`/${id}/submit`,'agent-1',{expectedVersion:2});
await call(`/${id}/approve`,'agent-3',{expectedVersion:2});
assert.equal((await call(`/${id}/publish`,'agent-1',{expectedVersion:2})).status,200);
assert.equal((await read(`/${id}`,'employee-2')).status,404,'group audience must be enforced');
assert.equal((await read(`/${id}`,'agent-3')).data.version,2);
assert.equal((await call(`/${id}/feedback`,'employee-1',vote,feedbackKey)).status,404,'replay also rechecks current audience');
assert.equal((await call(`/${id}/feedback`,'agent-3',{version:1,helpful:true})).status,409,'stale publication version must be rejected');
assert.equal((await read(`/${id}`,'agent-3')).data.feedback,null,'new publication has its own feedback');
assert.equal((await call(`/${id}/feedback`,'agent-3',{version:2,helpful:true})).status,200);
const groupReader=`knowledge-group-reader-${randomUUID()}`,groupKey=randomUUID();
await sql(`INSERT INTO employees(id,display_name) VALUES ('${groupReader}','Knowledge audience fixture');
  INSERT INTO group_memberships(employee_id,group_id) VALUES ('${groupReader}','service-desk')`);
assert.equal((await call(`/${id}/feedback`,groupReader,{version:2,helpful:false},groupKey)).status,200);
await sql(`DELETE FROM group_memberships WHERE employee_id='${groupReader}' AND group_id='service-desk'`);
assert.equal((await call(`/${id}/feedback`,groupReader,{version:2,helpful:false},groupKey)).status,404,'membership withdrawal blocks feedback replay');
await rejected(`INSERT INTO knowledge_feedback VALUES ('${id}',2,'employee-2',true,now())`,/KNOWLEDGE_FEEDBACK_UNAVAILABLE/);
await rejected(`INSERT INTO knowledge_feedback VALUES ('${id}',1,'agent-3',true,now())`,/KNOWLEDGE_FEEDBACK_UNAVAILABLE/);
assert.deepEqual((await read(`/${id}?scope=managed`,'agent-1')).data.feedbackSummary,{version:2,total:2,helpful:1,notHelpful:1});
const rollbackKey=randomUUID();
await sql(`CREATE FUNCTION reject_ci_knowledge_feedback_audit() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.article_id='${id}'::uuid AND NEW.actor_id='agent-1' AND NEW.action='FEEDBACK' THEN
      RAISE EXCEPTION 'CI_KNOWLEDGE_AUDIT_FAILURE';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER ci_knowledge_feedback_audit_failure BEFORE INSERT ON knowledge_audits
    FOR EACH ROW EXECUTE FUNCTION reject_ci_knowledge_feedback_audit()`);
try {
  assert.equal((await call(`/${id}/feedback`,'agent-1',{version:2,helpful:true},rollbackKey)).status,500);
  assert.equal((await sql(`SELECT count(*) FROM knowledge_feedback WHERE article_id='${id}' AND version=2 AND employee_id='agent-1'`)).output,'0','audit failure rolls back the feedback');
  assert.equal((await sql(`SELECT count(*) FROM knowledge_audits WHERE actor_id='agent-1' AND idempotency_key='${rollbackKey}'`)).output,'0','audit failure leaves no idempotency success');
} finally {
  await sql('DROP TRIGGER ci_knowledge_feedback_audit_failure ON knowledge_audits; DROP FUNCTION reject_ci_knowledge_feedback_audit()');
}
assert.equal((await call(`/${id}/feedback`,'agent-1',{version:2,helpful:true},rollbackKey)).status,200,'same request succeeds after the audit failure is repaired');
assert.equal((await sql(`SELECT count(*) FROM knowledge_versions WHERE article_id='${id}'`)).output,'2');
assert.equal((await call(`/${id}/archive`,'agent-1',{expectedVersion:2})).status,200);
assert.equal((await read(`/${id}`,'agent-3')).status,404);
assert.equal((await call(`/${id}/feedback`,'agent-3',{version:2,helpful:true})).status,404,'archived publication cannot receive feedback');
assert.equal((await sql(`SELECT count(*) FROM knowledge_audits WHERE article_id='${id}' AND action<>'FEEDBACK'`)).output,'9');
assert.equal((await sql(`SELECT count(*) FROM knowledge_audits WHERE article_id='${id}' AND action='FEEDBACK'`)).output,'6');
assert.equal((await sql(`SELECT count(*) FROM knowledge_feedback WHERE article_id='${id}'`)).output,'6','feedback history survives audience change and archive');
const expiredId=randomUUID();
await sql(`INSERT INTO knowledge_articles(id,owner_group_id,author_id,status,published_version,audience,title,body,review_due_at)
  VALUES ('${expiredId}','service-desk','agent-1','PUBLISHED',1,'EMPLOYEE','Expired fixture','Expired knowledge',now()-interval '1 hour');
  INSERT INTO knowledge_versions(article_id,version,title,body,audience,review_due_at,approved_by,published_by)
  VALUES ('${expiredId}',1,'Expired fixture','Expired knowledge','EMPLOYEE',now()-interval '1 hour','agent-3','agent-1')`);
assert.equal((await call(`/${expiredId}/feedback`,'employee-1',vote)).status,404,'expired publication cannot receive feedback');
await rejected(`INSERT INTO knowledge_feedback VALUES ('${expiredId}',1,'employee-1',true,now())`,/KNOWLEDGE_FEEDBACK_UNAVAILABLE/);
console.log('Knowledge publication, independent review, immutable versions and feedback, live audience, version-scoped summaries, content boundary and audit verified');
