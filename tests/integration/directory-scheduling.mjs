import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {DirectoryController} from '../../apps/api/dist/directory.controller.js';
import {AuthService} from '../../apps/api/dist/auth.service.js';
import {OperationLogsService} from '../../apps/api/dist/operation-logs.service.js';
import {synchronizeDirectory} from '../../apps/worker/dist/directory-sync.js';
import {DirectoryProviderError} from '../../apps/worker/dist/directory-provider.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true'
  ||process.env.ENABLE_DIRECTORY_SYNC==='true')throw new Error('DISPOSABLE_DIRECTORY_SCHEDULE_TEST_ONLY');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const control=new pg.Client({...connection,database:process.env.DB_NAME});
const name=`itsm_directory_schedule_${randomUUID().replaceAll('-','')}`;
const keys=['ENABLE_DIRECTORY_SYNC','DINGTALK_CORP_ID','DINGTALK_APP_KEY','DINGTALK_APP_SECRET','DINGTALK_DIRECTORY_ROOTS'];
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
let pool;
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migrated=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr);
  pool=new pg.Pool({...connection,database:name});
  const db={pool,transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  const auth=new AuthService(db),controller=new DirectoryController(auth,db),logs=new OperationLogsService(db);
  const admin={id:'demo-admin-1',name:'Admin fixture',groups:[]};
  const session=await db.transaction(c=>auth.issueSession(c,admin.id));
  const headers={'cookie':`itsm_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':randomUUID()};
  const employeeSession=await db.transaction(c=>auth.issueSession(c,'employee-1'));
  const employeeHeaders={cookie:`itsm_session=${employeeSession.token}`,'x-csrf-token':employeeSession.csrfToken,'idempotency-key':randomUUID()};
  Object.assign(process.env,{ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:'fixture-scheduled-directory',DINGTALK_APP_KEY:'fixture-key',
    DINGTALK_APP_SECRET:'fixture-secret',DINGTALK_DIRECTORY_ROOTS:'1'});
  const settings={corpId:process.env.DINGTALK_CORP_ID,roots:[1],retireMissing:false,maxRemovalPercent:10};
  let calls=0;
  const provider={snapshot:async()=>{calls++;return {departmentCount:1,people:[{userId:'fixture-directory-user',name:'Fixture user',departmentIds:[1],jobTitle:''}]};}};
  const scheduled=()=>synchronizeDirectory(pool,settings,provider,{scheduled:true});
  await assert.rejects(controller.sync({...headers,'x-csrf-token':undefined}),e=>e.getResponse().code==='CSRF_FAILED');
  await assert.rejects(controller.sync(employeeHeaders),e=>e.getResponse().code==='DIRECTORY_ADMIN_REQUIRED');
  await assert.rejects(controller.status(employeeHeaders),e=>e.getResponse().code==='DIRECTORY_ADMIN_REQUIRED');
  await assert.rejects(controller.sync({...headers,'idempotency-key':'bad'}),e=>e.getStatus()===400);
  process.env.ENABLE_DIRECTORY_SYNC='false';
  await assert.rejects(controller.sync(headers),e=>e.getResponse().code==='DIRECTORY_SYNC_NOT_ENABLED');
  process.env.ENABLE_DIRECTORY_SYNC='true';
  assert.equal((await scheduled()).state,'SUCCEEDED');assert.equal(calls,1);
  assert.equal((await scheduled()).state,'NOT_DUE','a new scheduler call/restart must not reset the persistent daily cadence');
  assert.equal(calls,1);
  const firstStatus=await controller.status(headers);
  assert.equal(firstStatus.automaticIntervalHours,24);assert.equal(firstStatus.stale,false);
  assert.equal(new Date(firstStatus.nextAutomaticAt)-new Date(firstStatus.runs[0].startedAt),86400000);
  const queued=await controller.sync(headers);assert.equal(queued.state,'QUEUED');
  assert.equal((await controller.sync(headers)).id,queued.id,'same request must remain idempotent');
  assert.equal((await controller.sync({...headers,'idempotency-key':randomUUID()})).id,queued.id,'only one pending job per enterprise');
  assert.equal((await controller.status(headers)).activeRun.id,queued.id);
  const beforeLog=await logs.detail(admin,`directory:${queued.id}`);
  assert.equal(beforeLog.actorId,admin.id);assert.equal(beforeLog.requestId,headers['idempotency-key']);
  assert.equal(beforeLog.result,'SUBMITTED');assert.equal(beforeLog.afterValue.triggerSource,'MANUAL');
  assert.equal((await scheduled()).state,'SUCCEEDED');assert.equal(calls,2);
  const completed=await logs.detail(admin,`directory:${queued.id}`);
  assert.equal(completed.result,'COMPLETED');assert.equal(completed.actorId,admin.id);
  assert.equal((await controller.status(headers)).nextAutomaticAt,firstStatus.nextAutomaticAt,'manual sync does not move the automatic schedule');
  assert.equal((await scheduled()).state,'NOT_DUE');assert.equal(calls,2);
  await pool.query("UPDATE directory_sync_runs SET started_at=now()-interval '25 hours' WHERE trigger_source='AUTOMATIC'");
  const denied={snapshot:async()=>{calls++;throw new DirectoryProviderError({stage:'MEMBER_API',vendorCode:88,vendorSubcode:'60011'});}};
  assert.equal((await synchronizeDirectory(pool,settings,denied,{scheduled:true})).state,'FAILED');
  assert.equal(calls,3);assert.equal((await scheduled()).state,'NOT_DUE','failed daily run must not retry every minute');
  assert.equal(calls,3);
  const failure=(await controller.status(headers)).runs[0];
  assert.equal(failure.errorCode,'DIRECTORY_PROVIDER_INVALID');
  assert.deepEqual(failure.errorDetails,{stage:'MEMBER_API',vendorCode:88,vendorSubcode:'60011'});
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM directory_people')).rows[0].count,1,'failure preserves the last complete snapshot');
  const retryHeaders={...headers,'idempotency-key':randomUUID()};
  const retry=await controller.sync(retryHeaders);assert.equal((await scheduled()).state,'SUCCEEDED');
  assert.equal((await controller.sync(retryHeaders)).id,retry.id,'a lost successful response must not enqueue another job');
  assert.equal((await pool.query("SELECT trigger_source FROM directory_sync_runs WHERE id=$1",[retry.id])).rows[0].trigger_source,'MANUAL');
  const blocker=await pool.connect();
  try{
    await blocker.query('SELECT pg_advisory_lock(71820535)');
    assert.equal((await scheduled()).state,'BUSY');
    await assert.rejects(controller.sync({...headers,'idempotency-key':randomUUID()}),e=>e.getResponse().code==='DIRECTORY_SYNC_BUSY');
  }finally{await blocker.query('SELECT pg_advisory_unlock(71820535)');blocker.release();}
  await pool.query("UPDATE directory_sync_runs SET started_at=now()-interval '25 hours' WHERE trigger_source='AUTOMATIC'");
  const concurrent=await Promise.all([scheduled(),scheduled(),scheduled()]);
  assert.equal(concurrent.filter(r=>r.state==='SUCCEEDED').length,1,'competing workers must execute the provider exactly once');
  const interrupted=await pool.query("INSERT INTO directory_sync_runs(corp_id,scope_hash,state,trigger_source) VALUES($1,'fixture','RUNNING','MANUAL') RETURNING id",[settings.corpId]);
  assert.equal((await scheduled()).state,'NOT_DUE');
  assert.equal((await pool.query('SELECT error_code FROM directory_sync_runs WHERE id=$1',[interrupted.rows[0].id])).rows[0].error_code,'DIRECTORY_INTERRUPTED');
  await pool.query("UPDATE directory_sync_runs SET completed_at=now()-interval '27 hours' WHERE state='SUCCEEDED'");
  assert.equal((await controller.status(headers)).stale,true);
  await pool.query("UPDATE role_bindings SET valid_from=now()-interval '2 days',valid_to=now()-interval '1 day' WHERE employee_id=$1",[admin.id]);
  await assert.rejects(controller.sync({...headers,'idempotency-key':randomUUID()}),e=>e.getResponse().code==='DIRECTORY_ADMIN_REQUIRED');
  console.log('PASS daily directory: durable 24h cadence, restart/failure/concurrency safety, manual queue, CSRF/admin expiry, idempotency, actor audit and retained snapshots');
}finally{
  for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  await pool?.end();await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await control.end();
}
