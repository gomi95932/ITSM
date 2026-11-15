import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const prefix=['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml'];
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
let sqlStep=0;
async function sql(query){
  const step=++sqlStep;
  const caller=new Error().stack?.split('\n')[2]?.match(/support-groups\.mjs:(\d+):/)?.[1]||'unknown';
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',[...prefix,'exec','-T','db','sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
    let text='',errorText='';child.stdout.on('data',chunk=>{text+=chunk;});
    child.stderr.on('data',chunk=>{errorText=(errorText+chunk).slice(-2048);});child.on('error',reject);
    child.on('close',code=>{
      const state=errorText.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5})\b/)?.[1]||'unavailable';
      code===0?resolve(text.trim()):reject(new Error(`GROUP_FIXTURE_SQL_FAILED step=${step} line=${caller} exit=${code} sqlstate=${state}`));
    });
  });
}
async function request(path,user='demo-admin-1',body,method=body?'POST':'GET',headers={}){
  const response=await fetch('http://127.0.0.1:8088/api/v1'+path,{method,headers:{'Content-Type':'application/json','X-Dev-User':user,...headers},
    body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
const a='demo-admin-1',b='demo-admin-2',g='ci-membership',subject='group-subject',peer='group-peer',lead='group-lead';
const root='/admin/support-groups';
await sql(`INSERT INTO employees(id,display_name) VALUES ('${subject}','Membership subject'),('${peer}','Membership peer'),('${lead}','Membership lead');`);
const detail=()=>request(`${root}/${g}`);
async function propose(employeeId,operation='ADD',user=a,extra={}){
  const group=(await detail()).data.group;
  return request(`${root}/${g}/members`,user,{id:randomUUID(),employeeId,operation,expectedGroupVersion:group.version,reason:'CI membership appointment',...extra});
}
const review=(change,user=b,decision='APPROVE',extra={})=>request(`${root}/${g}/members/${change.id}/review`,user,
  {expectedVersion:change.version,decision,reason:'Independent membership review',...extra});
async function add(employeeId){
  const pending=await propose(employeeId);assert.equal(pending.status,201,JSON.stringify(pending));
  const result=await review(pending.data);assert.equal(result.status,200,JSON.stringify(result));return result.data;
}
async function grant(employeeId,roleCode='DISPATCHER'){
  const pending=await request('/admin/role-bindings',a,{id:randomUUID(),employeeId,roleCode,groupId:g,
    validFrom:new Date(Date.now()-1000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),reason:'CI group appointment'});
  assert.equal(pending.status,201,JSON.stringify(pending));
  const result=await request(`/admin/role-bindings/${pending.data.id}/review`,b,{expectedVersion:1,decision:'APPROVE',reason:'Independent role review'});
  assert.equal(result.status,200,JSON.stringify(result));return result.data;
}
assert.equal((await request(root,'employee-1')).status,404);
assert.equal((await request(root,'agent-1')).status,404,'membership alone is not group administration');
assert.equal((await request(root,a,{id:g,name:'CI Membership',reason:'CI group creation'})).status,201);
assert.equal((await request(root,a,{id:g,name:'Duplicate',reason:'CI duplicate'})).status,409);
assert.equal((await request(root,a,{id:'bad id',name:'Bad',reason:'CI invalid'})).status,400);
assert.equal((await request(root,a,{id:'ci-secret',name:'Secret',reason:'password=blocked-group-sentinel'})).status,403);
assert.equal((await request(`${root}/people?q=x`)).status,400);
assert.equal((await request(`${root}/people?q=group-`)).data.items.length,3);
const adminToken=randomBytes(32).toString('hex'),csrf='membership-session-csrf';
await sql(`INSERT INTO auth_sessions(token_hash,csrf_token,employee_id,expires_at) VALUES
  (${quote(createHash('sha256').update(adminToken).digest('hex'))},${quote(csrf)},'${a}',now()+interval '1 hour')`);
const cookie={Cookie:`itsm_session=${adminToken}`};
const sessionGroup={id:'ci-session-group',name:'Session group',reason:'Session CSRF boundary'};
assert.equal((await request(root,a,sessionGroup,'POST',cookie)).data.code,'CSRF_FAILED');
assert.equal((await request(root,a,sessionGroup,'POST',{...cookie,'X-CSRF-Token':'wrong'})).data.code,'CSRF_FAILED');
assert.equal((await request(root,a,sessionGroup,'POST',{...cookie,'X-CSRF-Token':csrf})).status,201);
await sql(`DELETE FROM auth_sessions WHERE token_hash=${quote(createHash('sha256').update(adminToken).digest('hex'))}`);
assert.equal((await propose(a)).status,403,'self-change denied');
assert.equal((await propose(subject,'ADD',a,{canReview:true})).status,400,'overposting denied');
let pending=await propose(subject);assert.equal(pending.status,201);
const replayBody={id:pending.data.id,employeeId:subject,operation:'ADD',expectedGroupVersion:pending.data.groupVersion,reason:pending.data.reason};
assert.deepEqual((await request(`${root}/${g}/members`,a,replayBody)).data,pending.data);
assert.equal((await request(`${root}/${g}/members`,a,{...replayBody,reason:'Changed'})).status,409);
assert.equal((await propose(subject)).status,409,'duplicate proposal denied');
assert.equal((await review(pending.data,a)).status,403);
assert.equal(await sql(`SELECT count(*) FROM group_memberships WHERE group_id='${g}'`),'0','proposal grants nothing');
const decisions=await Promise.all([review(pending.data),review(pending.data)]);
assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
let removal=await propose(subject,'REMOVE');
assert.equal((await review(removal.data)).data.code,'GROUP_LAST_MEMBER_REQUIRED');
await review(removal.data,b,'REJECT');
await add(peer);await add(lead);
const subjectRole=await grant(subject),leadRole=await grant(lead,'GROUP_LEAD');
assert.deepEqual((await request(root,lead)).data.items.map(row=>row.id),[g],'lead scope is restricted');
assert.equal((await request(`${root}/service-desk`,lead)).status,404);
assert.equal((await request(root,lead,{id:'ci-forbidden',name:'Forbidden',reason:'CI denied'})).status,404);
assert.equal((await request(`${root}/${g}`,lead,{name:'Forbidden',expectedVersion:4,reason:'CI denied'},'PATCH')).status,404);
const byLead=await propose('employee-2','ADD',lead);assert.equal(byLead.status,201);
assert.equal((await review(byLead.data,lead)).status,404,'lead cannot review');
assert.equal((await review(byLead.data,b,'REJECT')).status,200);

const stale=await propose('employee-2');
let group=(await detail()).data.group;
assert.equal((await request(`${root}/${g}`,a,{name:'CI Membership renamed',expectedVersion:group.version,reason:'Reviewed naming'},'PATCH')).status,200);
assert.equal((await review(stale.data)).data.code,'GROUP_VERSION_CONFLICT');
assert.equal((await review(stale.data,b,'REJECT')).status,200,'stale proposal remains rejectable');
assert.equal((await request(`${root}/${g}`,a,{name:'Stale',expectedVersion:group.version,reason:'Stale write'},'PATCH')).status,409);

const token=randomBytes(32).toString('hex');
await sql(`INSERT INTO auth_sessions(token_hash,csrf_token,employee_id,expires_at) VALUES
  (${quote(createHash('sha256').update(token).digest('hex'))},'fixture-csrf','${subject}',now()+interval '1 hour');
  INSERT INTO service_catalog(code,type,form_version,published,group_id) VALUES ('INC-GROUP-CI','INC',1,true,'${g}');
  INSERT INTO priority_reviewers(employee_id,group_id) VALUES ('${subject}','${g}');`);
removal=await propose(subject,'REMOVE');
assert.equal((await review(removal.data)).data.code,'GROUP_SPECIALIST_CONTINUITY_REQUIRED');
await sql(`INSERT INTO priority_reviewers(employee_id,group_id) VALUES ('${peer}','${g}');
  INSERT INTO tickets(number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,subject,description,fields,impact,urgency,priority,status,assignee_id)
  VALUES ('GROUP-CI-OWNER','employee-1','employee-1','${g}','INC-GROUP-CI','INC',1,'CI owner','Ordinary fixture','{}','INDIVIDUAL','LOW','P4','IN_PROGRESS','${subject}');`);
assert.equal((await review(removal.data)).data.code,'GROUP_RESPONSIBILITY_TRANSFER_REQUIRED');
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id='${subjectRole.id}'`),'ACTIVE','failed removal preserves role');
await sql(`UPDATE tickets SET assignee_id='${peer}',pending_group_id='${g}',pending_assignee_id='${subject}' WHERE number='GROUP-CI-OWNER'`);
assert.equal((await review(removal.data)).data.code,'GROUP_RESPONSIBILITY_TRANSFER_REQUIRED','pending handover must be handled');
await sql(`UPDATE tickets SET pending_group_id=NULL,pending_assignee_id=NULL WHERE number='GROUP-CI-OWNER'`);
const knowledge=randomUUID();
await sql(`INSERT INTO knowledge_articles(id,owner_group_id,author_id,audience,title,body,review_due_at)
  VALUES ('${knowledge}','${g}','${subject}','SUPPORT_GROUP','Membership continuity','Ordinary knowledge fixture',now()+interval '1 day')`);
for(const state of ['DRAFT','IN_REVIEW','APPROVED']){
  await sql(`UPDATE knowledge_articles SET status='${state}' WHERE id='${knowledge}'`);
  const blocked=await review(removal.data);
  assert.equal(blocked.status,409);assert.equal(blocked.data.knowledge,1,`${state} knowledge must be handed over`);
}
await sql(`UPDATE knowledge_articles SET status='ARCHIVED' WHERE id='${knowledge}'`);
const fulfillmentTicket=randomUUID();
await sql(`INSERT INTO service_catalog(code,type,form_version,published,group_id) VALUES ('REQ-GROUP-CI','REQ',1,true,'${g}');
  INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,subject,description,fields,impact,urgency,priority,status)
    VALUES ('${fulfillmentTicket}','GROUP-CI-FULFILLMENT','employee-1','employee-1','${g}','REQ-GROUP-CI','REQ',1,'CI delivery','Ordinary delivery fixture','{}','INDIVIDUAL','LOW','P4','CLOSED');
  INSERT INTO request_approvals(ticket_id,corp_id,snapshot,expires_at,state,provider_instance_id,last_verified_at,next_at)
    VALUES ('${fulfillmentTicket}','ci-group','{}',now()+interval '1 day','APPROVED','ci-group-approval',now(),now()+interval '1 day');
  INSERT INTO request_fulfillments(approval_id,ticket_id,assignee_id,ready_until)
    SELECT id,ticket_id,'${subject}',now()+interval '1 day' FROM request_approvals WHERE ticket_id='${fulfillmentTicket}';`);
let blocked=await review(removal.data);
assert.equal(blocked.status,409);assert.equal(blocked.data.fulfillments,1,'READY delivery must block removal even on a closed ticket');
await sql(`UPDATE request_fulfillments SET state='DELIVERED',delivered_at=now(),access_expires_at=now()+interval '1 day' WHERE ticket_id='${fulfillmentTicket}'`);
for(const state of ['DELIVERED','REVOKE_DUE','BLOCKED']){
  await sql(`UPDATE request_fulfillments SET state='${state}' WHERE ticket_id='${fulfillmentTicket}'`);
  blocked=await review(removal.data);
  assert.equal(blocked.status,409);assert.equal(blocked.data.fulfillments,1,`${state} delivery still carries recovery responsibility`);
}
await sql(`UPDATE request_fulfillments SET state='REVOKED',revoked_at=now() WHERE ticket_id='${fulfillmentTicket}'`);
assert.equal((await review(removal.data)).status,200);
assert.equal(await sql(`SELECT count(*) FROM auth_sessions WHERE employee_id='${subject}'`),'0');
assert.equal(await sql(`SELECT count(*) FROM priority_reviewers WHERE employee_id='${subject}' AND group_id='${g}'`),'0');
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id='${subjectRole.id}'`),'REVOKED');
assert.equal((await request('/auth/me',subject)).data.groups.includes(g),false);
const staleRole=randomUUID();
await sql(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,requested_by,reason)
  VALUES ('${staleRole}','${subject}','DISPATCHER','${g}',now(),now()+interval '1 day','${a}','CI out-of-band stale appointment')`);
const staleMembership=await propose(subject);
assert.equal((await review(staleMembership.data)).data.code,'GROUP_STALE_ROLE_REVIEW_REQUIRED');
assert.equal(await sql(`SELECT count(*) FROM group_memberships WHERE employee_id='${subject}' AND group_id='${g}'`),'0');
assert.equal((await request(`/admin/role-bindings/${staleRole}/review`,b,{expectedVersion:1,decision:'REJECT',reason:'Reject orphan appointment'})).status,200);
assert.equal((await review(staleMembership.data,b,'REJECT')).status,200);
await add(subject);
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id='${subjectRole.id}'`),'REVOKED','rejoin never restores role');
assert.equal(await sql(`SELECT count(*) FROM role_binding_audits WHERE binding_id='${subjectRole.id}' AND action='REVOKED'`),'1');
removal=await propose(lead,'REMOVE');
assert.equal((await review(removal.data)).data.code,'GROUP_LAST_LEAD_REQUIRED');
await review(removal.data,b,'REJECT');

const unavailable=await propose('employee-2');
await sql("UPDATE employees SET active=false WHERE id='employee-2'");
assert.equal((await review(unavailable.data)).data.code,'GROUP_SUBJECT_UNAVAILABLE');
await sql("UPDATE employees SET active=true WHERE id='employee-2'");
await review(unavailable.data,b,'REJECT');
const audit=await request(`${root}/${g}/history`);
assert.equal(audit.status,200);assert.ok(audit.data.items.some(row=>row.action==='MEMBER_APPROVED'&&row.beforeValue?.removedCapabilities));
assert.equal(await sql("SELECT count(*) FROM support_group_audits WHERE strpos(row_to_json(support_group_audits)::text,'blocked-group-sentinel')>0"),'0');
// Leave a harmless, isolated fixture; never mutate actual users or production data.
assert.equal(await sql(`SELECT status FROM role_bindings WHERE id='${leadRole.id}'`),'ACTIVE');
console.log('Support-group scope, independent membership review, stale writes, obligations, continuity, session revocation and audit verified');
