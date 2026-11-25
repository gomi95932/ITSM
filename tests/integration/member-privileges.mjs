import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {MemberPrivilegesService} from '../../apps/api/dist/member-privileges.service.js';
import {KnowledgeService} from '../../apps/api/dist/knowledge.service.js';
import {RequestCatalogService} from '../../apps/api/dist/request-catalog.service.js';
import {TicketsService} from '../../apps/api/dist/tickets.service.js';
import {OperationLogsService} from '../../apps/api/dist/operation-logs.service.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')
  throw new Error('DISPOSABLE_MEMBER_PRIVILEGES_TEST_ONLY');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,statement_timeout:30000};
const control=new pg.Client({...connection,database:process.env.DB_NAME}),name=`itsm_grants_${randomUUID().replaceAll('-','')}`;
const actor=(id,groups=[])=>({id,name:id,groups}),admin=actor('demo-admin-1'),other=actor('demo-admin-2');
const engineer=actor('agent-1',['service-desk']),reviewer=actor('agent-3',['service-desk']);
const denied=(promise,code)=>assert.rejects(promise,e=>e.getResponse?.().code===code,`Expected ${code}`);
let pool;
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migration=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migration.status,0,migration.stderr);
  pool=new pg.Pool({...connection,database:name});
  const db={pool,transaction:async fn=>{
    const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }},intake={requireGeneral:async()=>{}};
  const grants=new MemberPrivilegesService(db,intake),knowledge=new KnowledgeService(db,intake);
  const catalog=new RequestCatalogService(db,intake),tickets=new TicketsService(db,{}, {},intake),logs=new OperationLogsService(db);
  const input=async(employee,privileges=[],catalogServiceCodes=[],group='service-desk')=>({id:randomUUID(),
    expectedGroupVersion:(await grants.get(admin,group,employee)).group.version,privileges,catalogServiceCodes,
    reason:'Isolated member privilege acceptance',contentClass:'GENERAL'});
  const save=async(employee,privileges=[],codes=[],group='service-desk')=>grants.save(admin,group,employee,await input(employee,privileges,codes,group));
  const state=async()=>JSON.stringify((await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY employee_id,group_id) FROM group_memberships m) members,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM role_bindings r) roles`)).rows);
  const original=await state();
  for(const person of [actor('employee-1'),engineer,reviewer]){
    await assert.rejects(grants.get(person,'service-desk',engineer.id),e=>e.getStatus()===404);
    await assert.rejects(grants.save(person,'service-desk',engineer.id,await input(engineer.id)),e=>e.getStatus()===404);
  }
  await assert.rejects(grants.get(admin,'service-desk','employee-1'),e=>e.getStatus()===404);
  await assert.rejects(grants.save(admin,'service-desk','employee-1',{...await input(engineer.id),privileges:['P1_REVIEW']}),e=>e.getStatus()===404);
  const available=await grants.get(admin,'service-desk',engineer.id);
  assert(available.catalogServices.some(s=>s.code==='REQ-ACCOUNT'));
  assert(available.catalogServices.every(s=>s.code.startsWith('REQ-')));
  await denied(grants.save(admin,'service-desk',engineer.id,await input(engineer.id,['P1_REVIEW'],['INC-PC'])),'MEMBER_PRIVILEGE_CATALOG_SCOPE');
  await pool.query("INSERT INTO service_catalog(code,type,form_version,published,group_id,required_fields) VALUES('REQ-OTHER','REQ',1,false,'applications','[]')");
  await denied(grants.save(admin,'service-desk',engineer.id,await input(engineer.id,['P1_REVIEW'],['REQ-OTHER'])),'MEMBER_PRIVILEGE_CATALOG_SCOPE');
  assert.deepEqual((await grants.get(admin,'service-desk',engineer.id)).privileges,[],'invalid scope rolls back all grants');
  await pool.query("UPDATE employees SET active=false WHERE id='agent-1'");
  await denied(grants.save(admin,'service-desk',engineer.id,await input(engineer.id)),'SUPPORT_PERSON_UNAVAILABLE');
  await pool.query("UPDATE employees SET active=true WHERE id='agent-1'");
  await assert.rejects(pool.query("UPDATE support_groups SET enabled=false WHERE id='service-desk'"),/SUPPORT_GROUP_DEPENDENCIES/);

  const all=['P1_REVIEW','KNOWLEDGE_EDIT','KNOWLEDGE_REVIEW'],grant=await input(engineer.id,all,['REQ-ACCOUNT']);
  const [receipt,retry]=await Promise.all([grants.save(admin,'service-desk',engineer.id,grant),grants.save(admin,'service-desk',engineer.id,grant)]);
  assert.deepEqual(receipt,retry);assert.equal(receipt.version,grant.expectedGroupVersion+1);
  assert.equal((await pool.query('SELECT 1 FROM member_privilege_audits WHERE id=$1',[grant.id])).rowCount,1);
  await denied(grants.save(other,'service-desk',engineer.id,grant),'IDEMPOTENCY_KEY_REUSED');
  await denied(grants.save(admin,'service-desk',engineer.id,{...grant,reason:'Changed retry'}),'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await state(),original,'grants do not change memberships or platform roles');
  assert.equal((await knowledge.roles(engineer)).groups[0].editor,true);
  assert.equal((await catalog.versions(engineer,'REQ-ACCOUNT')).code,'REQ-ACCOUNT');
  await denied(catalog.versions(engineer,'REQ-OTHER'),'CATALOG_PUBLISHER_REQUIRED');

  const pending=async(requester)=>{
    const id=randomUUID();
    await pool.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
      subject,description,fields,impact,urgency,priority,status,priority_review_state,priority_candidate_at)
      VALUES($1,$2,$3,$3,'service-desk','INC-PC','INC',1,'Privilege acceptance','Disposable fixture','{}','COMPANY','HIGH','P1','QUEUED','PENDING',now())`,
      [id,`GRANT-${id}`,requester]);return id;
  };
  const reviewBody={contentClass:'GENERAL',expectedVersion:1,priority:'P1',reason:'Independent acceptance'};
  const own=await pending(engineer.id);
  await denied(tickets.reviewPriority(engineer,own,reviewBody,randomUUID(),randomUUID()),'PRIORITY_REVIEWER_REQUIRED');
  await tickets.reviewPriority(reviewer,own,reviewBody,randomUUID(),randomUUID());
  const stranded=await pending(reviewer.id);
  await denied(save(engineer.id,['KNOWLEDGE_EDIT','KNOWLEDGE_REVIEW'],['REQ-ACCOUNT']),'MEMBER_PRIVILEGE_PENDING_P1');
  await tickets.reviewPriority(engineer,stranded,reviewBody,randomUUID(),randomUUID());
  await denied(save('agent-2',[],[],'applications'),'SUPPORT_REVIEW_CONTINUITY_REQUIRED');

  await save(reviewer.id,['P1_REVIEW','KNOWLEDGE_REVIEW']);
  const article=await knowledge.create(engineer,{groupId:'service-desk',title:'Member permission test',body:'Disposable knowledge content',
    audience:'EMPLOYEE',reviewDueAt:new Date(Date.now()+7*86400000).toISOString(),contentClass:'GENERAL'},randomUUID(),randomUUID());
  await denied(save(engineer.id,['P1_REVIEW','KNOWLEDGE_REVIEW'],['REQ-ACCOUNT']),'MEMBER_PRIVILEGE_PENDING_KNOWLEDGE');
  await knowledge.transition(engineer,article.id,'SUBMIT',{expectedVersion:1},randomUUID(),randomUUID());
  await denied(knowledge.transition(engineer,article.id,'APPROVE',{expectedVersion:1},randomUUID(),randomUUID()),'KNOWLEDGE_VERSION_OR_STATE_CONFLICT');
  await denied(save(reviewer.id,['P1_REVIEW']),'MEMBER_PRIVILEGE_PENDING_KNOWLEDGE');
  await knowledge.transition(reviewer,article.id,'APPROVE',{expectedVersion:1},randomUUID(),randomUUID());
  await knowledge.transition(engineer,article.id,'PUBLISH',{expectedVersion:1},randomUUID(),randomUUID());
  await save(engineer.id,[],[]);
  assert.deepEqual((await knowledge.roles(engineer)).groups,[]);
  await denied(knowledge.create(engineer,{groupId:'service-desk',title:'Revoked',body:'Must fail',audience:'EMPLOYEE',
    reviewDueAt:new Date(Date.now()+7*86400000).toISOString(),contentClass:'GENERAL'},randomUUID(),randomUUID()),'KNOWLEDGE_ROLE_REQUIRED');
  await denied(catalog.versions(engineer,'REQ-ACCOUNT'),'CATALOG_PUBLISHER_REQUIRED');
  const deniedTicket=await pending('employee-1');
  await denied(tickets.reviewPriority(engineer,deniedTicket,reviewBody,randomUUID(),randomUUID()),'PRIORITY_REVIEWER_REQUIRED');
  await tickets.reviewPriority(reviewer,deniedTicket,reviewBody,randomUUID(),randomUUID());
  await save(reviewer.id,['P1_REVIEW']);

  const concurrent=await input(engineer.id,['P1_REVIEW']);
  const outcomes=await Promise.allSettled([grants.save(admin,'service-desk',engineer.id,concurrent),
    grants.save(admin,'service-desk',engineer.id,{...concurrent,id:randomUUID(),privileges:['KNOWLEDGE_REVIEW']})]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(outcomes.find(r=>r.status==='rejected').reason.getResponse().code,'SUPPORT_VERSION_CONFLICT');
  const audit=await logs.detail(admin,`member-privileges:${grant.id}`);
  assert.equal(audit.action,'MEMBER_PRIVILEGES_APPLIED');assert.deepEqual(audit.beforeValue.privileges,[]);
  assert.deepEqual(audit.afterValue.catalogServiceCodes,['REQ-ACCOUNT']);assert.equal(audit.actorId,admin.id);
  await assert.rejects(pool.query('DELETE FROM member_privilege_audits WHERE id=$1',[grant.id]),/IMMUTABLE/);
  await assert.rejects(pool.query("UPDATE member_privilege_audits SET reason='tampered' WHERE id=$1",[grant.id]),/IMMUTABLE/);
  for(const column of ['employee','role']){
    if(column==='employee')await pool.query("UPDATE employees SET active=false WHERE id='demo-admin-1'");
    else await pool.query("UPDATE role_bindings SET valid_from=now()-interval '2 days',valid_to=now()-interval '1 day' WHERE employee_id='demo-admin-1'");
    await assert.rejects(grants.get(admin,'service-desk',engineer.id),e=>e.getStatus()===404);
    await assert.rejects(grants.save(admin,'service-desk',engineer.id,concurrent),e=>e.getStatus()===404);
    await pool.query("UPDATE employees SET active=true WHERE id='demo-admin-1'");
  }
  console.log('PASS member privileges: scoped admin grants, atomic validation, retries, concurrency, immediate revoke, P1 independence, knowledge workflow and immutable central logs');
}finally{
  try{
    await pool?.end();
    // Let PostgreSQL observe the closed pool sockets before dropping the isolated database.
    for(let attempt=0;attempt<50;attempt++){
      const {rows}=await control.query('SELECT count(*)::integer AS active FROM pg_stat_activity WHERE datname=$1',[name]);
      if(rows[0].active===0)break;
      if(attempt===49)throw new Error('MEMBER_PRIVILEGES_DATABASE_CONNECTIONS_REMAIN');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    await control.query(`DROP DATABASE IF EXISTS ${name}`);
  }finally{await control.end();}
}
