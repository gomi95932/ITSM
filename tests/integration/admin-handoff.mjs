import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { handoffAdministrators } from '../../apps/api/dist/admin-handoff.js';
import { ROLE_EFFECTIVE_SQL } from '../../apps/api/dist/role-policy.js';
import { RolesService } from '../../apps/api/dist/roles.service.js';
import { synchronizeDirectory,directoryEmployeeId } from '../../apps/worker/dist/directory-sync.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')
  throw new Error('DISPOSABLE_ADMIN_HANDOFF_CI_ONLY');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,statement_timeout:30000};
const control=new pg.Client({...connection,database:process.env.DB_NAME});
const database=`itsm_handoff_${randomUUID().replaceAll('-','')}`;
let db;
await control.connect();
try{
  await control.query(`CREATE DATABASE ${database}`);
  const env={...process.env,DB_NAME:database};
  const migrated=spawnSync(process.execPath,['scripts/migrate.mjs'],{env,encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr);
  db=new pg.Pool({...connection,database});
  const settings={corpId:'ci-corp',roots:[123],pilotUserIds:['first','second','third'],retireMissing:false,maxRemovalPercent:10};
  const provider={snapshot:async()=>({departmentCount:1,people:[
    {userId:'first',name:'First real admin',departmentIds:[123],jobTitle:''},
    {userId:'second',name:'Second real admin',departmentIds:[123],jobTitle:''},
    {userId:'third',name:'Pilot employee',departmentIds:[123],jobTitle:''},
    {userId:'outside',name:'Excluded employee',departmentIds:[123],jobTitle:''}]} )};
  const sync=await synchronizeDirectory(db,settings,provider);
  assert.equal(sync.state,'SUCCEEDED');assert.equal(sync.people,3);
  assert.equal((await db.query('SELECT count(*)::int n FROM identity_links')).rows[0].n,3);
  const previousBindingIds=(await db.query("SELECT id FROM role_bindings WHERE role_code='PLATFORM_ADMIN' ORDER BY id")).rows.map(r=>r.id);
  const selection={requestId:randomUUID(),corpId:settings.corpId,roots:settings.roots,pilotUserIds:settings.pilotUserIds,
    admins:[{userId:'first',name:'First real admin'},{userId:'second',name:'Second real admin'}],previousBindingIds,
    executionPrincipal:'CI isolated maintenance executor',authorityRef:'CI fixture authorization',reason:'CI real identity handoff',
    configurationSha256:'a'.repeat(64),backupRef:'CI disposable backup fixture',validUntil:new Date(Date.now()+30*86400000).toISOString()};
  async function transaction(fn,commit=false){
    const client=await db.connect();
    try{await client.query('BEGIN');const result=await fn(client);await client.query(commit?'COMMIT':'ROLLBACK');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const snapshot=async()=>JSON.stringify((await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM role_bindings r) roles,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM role_binding_audits a) audits,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM employees e) people,
    (SELECT count(*) FROM admin_handoffs) handoffs`)).rows);
  const before=await snapshot();
  assert.equal((await transaction(c=>handoffAdministrators(c,selection))).state,'PREVIEW');
  assert.equal(await snapshot(),before,'preview preserves all authorization state');
  await assert.rejects(transaction(c=>handoffAdministrators(c,{...selection,admins:[selection.admins[0],{userId:'second',name:'Wrong name'}]},true)),/HANDOFF_ADMIN_IDENTITY_MISMATCH/);
  await assert.rejects(transaction(c=>handoffAdministrators(c,{...selection,previousBindingIds:[randomUUID(),randomUUID()]},true)),/HANDOFF_DEMO_BASELINE_CHANGED/);
  await assert.rejects(transaction(async c=>{
    await c.query("UPDATE directory_sync_runs SET completed_at=now()-interval '16 minutes'");
    return handoffAdministrators(c,selection,true);
  }),/HANDOFF_RECENT_DIRECTORY_REQUIRED/);
  await assert.rejects(transaction(async c=>{
    await c.query("UPDATE employees SET active=false WHERE id=$1",[directoryEmployeeId(settings.corpId,'first')]);
    return handoffAdministrators(c,selection,true);
  }),/HANDOFF_DIRECTORY_IDENTITY_MISMATCH/);
  await assert.rejects(transaction(async c=>{
    await c.query("INSERT INTO identity_links VALUES('other-corp','linked-demo','demo-admin-1')");
    return handoffAdministrators(c,selection,true);
  }),/HANDOFF_DEMO_HAS_REAL_IDENTITY/);
  assert.equal(await snapshot(),before,'all rejected plans preserve state');
  await db.query("INSERT INTO auth_sessions(token_hash,csrf_token,employee_id,expires_at) VALUES('ci-demo-session','ci-csrf','demo-admin-1',now()+interval '1 hour')");
  await assert.rejects(transaction(async c=>{await handoffAdministrators(c,selection,true);throw new Error('CI_ROLLBACK');}),/CI_ROLLBACK/);
  assert.equal(await snapshot(),before,'failed transaction preserves demo grants and audit history');
  assert.equal((await db.query('SELECT count(*)::int n FROM auth_sessions')).rows[0].n,1,'failed transaction restores revoked sessions');
  const cli=['apps/api/dist/handoff-role-admins.js','--apply'];
  assert.notEqual(spawnSync(process.execPath,cli,{env,input:JSON.stringify(selection),encoding:'utf8'}).status,0,'CLI requires explicit confirmation');
  assert.notEqual(spawnSync(process.execPath,cli,{env:{...env,ITSM_ADMIN_HANDOFF_CONFIRM:'TRANSFER_DEMO_ADMINS',NODE_ENV:'development'},
    input:JSON.stringify(selection),encoding:'utf8'}).status,0,'CLI requires production authentication mode');
  const result=await transaction(c=>handoffAdministrators(c,selection,true),true);
  assert.equal(result.state,'APPLIED');
  const admins=(await db.query(`SELECT employee_id FROM role_bindings r WHERE role_code='PLATFORM_ADMIN' AND ${ROLE_EFFECTIVE_SQL}`)).rows.map(r=>r.employee_id).sort();
  assert.deepEqual(admins,['first','second'].map(user=>directoryEmployeeId(settings.corpId,user)).sort());
  assert.equal((await db.query("SELECT count(*)::int n FROM employees WHERE id LIKE 'demo-admin-%' AND active")).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM auth_sessions')).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM role_bindings WHERE id=ANY($1::uuid[]) AND status='REVOKED'",[previousBindingIds])).rows[0].n,2);
  assert.equal((await db.query("SELECT count(*)::int n FROM role_binding_audits WHERE action='BOOTSTRAPPED'")).rows[0].n,2,'bootstrap audit history survives');
  const roles=new RolesService({pool:db,transaction:fn=>transaction(fn,true)},{});
  const actor={id:admins[0],name:'First real admin',groups:[]};
  assert.equal((await roles.list(actor)).canReview,true,'real administrator passes the existing platform authorization');
  await assert.rejects(roles.list({id:'demo-admin-1',groups:[]}),error=>error.getStatus()===404,'demo administrator loses platform access');
  await assert.rejects(roles.list({id:directoryEmployeeId(settings.corpId,'third'),groups:[]}),error=>error.getStatus()===404,'pilot employee receives no admin role');
  const history=(await roles.history(actor,(await roles.list(actor)).items.find(r=>r.source==='HANDOFF').id)).items;
  assert.equal(history[0].actorId,null);assert.equal(history[0].executionPrincipal,selection.executionPrincipal);
  assert.equal(history[0].authorityRef,selection.authorityRef,'audit records the executor and actual authorization source');
  await assert.rejects(transaction(c=>handoffAdministrators(c,selection,true)),/HANDOFF_ALREADY_COMPLETED/);
  await assert.rejects(transaction(c=>c.query(`INSERT INTO role_bindings(id,employee_id,role_code,valid_from,valid_to,status,source,reason)
    VALUES($1,$2,'PLATFORM_ADMIN',now(),now()+interval '1 day','ACTIVE','REVIEW','invalid fixture')`,[randomUUID(),directoryEmployeeId(settings.corpId,'third')])));
  await assert.rejects(transaction(c=>c.query(`INSERT INTO role_binding_audits(binding_id,action,after_value,reason)
    VALUES($1,'APPROVED','{}','invalid fixture')`,[previousBindingIds[0]])),'ordinary review audit still requires a human actor');
  await assert.rejects(transaction(c=>c.query(`INSERT INTO role_bindings(id,employee_id,role_code,valid_from,valid_to,status,source,reason,requested_by,reviewed_by)
    VALUES($1,$2,'PLATFORM_ADMIN',now(),now()+interval '1 day','ACTIVE','REVIEW','invalid fixture','demo-admin-1','demo-admin-1')`,
    [randomUUID(),directoryEmployeeId(settings.corpId,'third')])),'reviewer must remain independent');
  await assert.rejects(transaction(c=>c.query(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,source,reason,requested_by,reviewed_by)
    VALUES($1,$2,'PLATFORM_ADMIN','service-desk',now(),now()+interval '1 day','ACTIVE','REVIEW','invalid fixture','demo-admin-1','demo-admin-2')`,
    [randomUUID(),directoryEmployeeId(settings.corpId,'third')])),'platform role must remain outside group scope');
  console.log('Admin handoff verified: migration, pilot filtering, recent identity proof, preview, rejected baselines, rollback, real authorization, demo session revocation, preserved audit and replay refusal');
}finally{
  if(db)await db.end();
  await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);await control.end();
}
