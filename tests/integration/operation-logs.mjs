import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {OperationLogsService} from '../../apps/api/dist/operation-logs.service.js';
import {SupportService} from '../../apps/api/dist/support.service.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')
  throw new Error('DISPOSABLE_OPERATION_LOG_TEST_ONLY');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const control=new pg.Client({...connection,database:process.env.DB_NAME});
const name=`itsm_operation_logs_${randomUUID().replaceAll('-','')}`;
let pool;
const identity=id=>({id,name:id,groups:[]});
const admin=identity('demo-admin-1');
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migrated=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr);
  pool=new pg.Pool({...connection,database:name});
  const db={pool,transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  const logs=new OperationLogsService(db),support=new SupportService(db,{requireGeneral:async()=>{}});
  const created=await support.propose(admin,{id:randomUUID(),kind:'GROUP_CREATE',groupId:'log-fixture',expectedGroupVersion:null,
    config:{name:'Log fixture group',description:'test'},reason:'Centralized audit fixture',contentClass:'GENERAL'},true);
  const supportLogs=await logs.list(admin,{module:'support',object:'log-fixture'});
  assert.equal(supportLogs.total,2,'submission and application must each appear once without mirrored generic audits');
  assert.deepEqual(new Set(supportLogs.items.map(row=>row.action)),new Set(['GROUP_CREATE_PROPOSED','GROUP_CREATE_APPLIED']));
  assert.equal(supportLogs.items.find(row=>row.action==='GROUP_CREATE_APPLIED').result,'APPLIED');
  for(const row of supportLogs.items)assert.equal((await logs.detail(admin,row.id)).sourceTable,'support_structure_audits');
  assert.equal((await pool.query('SELECT status FROM support_structure_proposals WHERE id=$1',[created.id])).rows[0].status,'APPROVED');
  await pool.query(`INSERT INTO operational_audits(actor_id,action,target_id,created_at)
    SELECT $1,'DINGTALK_WEB_LOGIN','fixture-login-'||n,date_trunc('milliseconds',now())-n*interval '1 second' FROM generate_series(1,25)n`,[admin.id]);
  const first=await logs.list(admin,{module:'authentication',size:'20'}),second=await logs.list(admin,{module:'authentication',size:'20',page:'2'});
  assert.equal(first.total,25);assert.equal(first.items.length,20);assert.equal(second.items.length,5);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,25);
  assert.equal((await logs.list(admin,{module:'authentication',actor:'演示配置管理员一'})).total,25);
  assert.equal((await logs.list(admin,{q:"%' OR 1=1 --"})).total,0);
  assert.equal((await logs.list(admin,{module:'authentication',object:'fixture-login-1'})).total,1);
  const exact=await logs.list(admin,{module:'authentication',from:first.items[0].createdAt.toISOString(),to:first.items[0].createdAt.toISOString()});
  assert.equal(exact.total,1);
  await pool.query(`INSERT INTO directory_sync_runs(corp_id,scope_hash,state,people_count) VALUES('fixture','fixture','SUCCEEDED',7)`);
  assert.equal((await logs.list(admin,{module:'directory'})).items[0].actorId,null);
  const dir=(await logs.list(admin,{module:'directory'})).items[0];
  assert.equal((await logs.detail(admin,dir.id)).afterValue.peopleCount,7);
  const ticket=randomUUID(),event=randomUUID();
  await pool.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
    subject,description,fields,impact,urgency,priority,status) VALUES($1,'FIXTURE-LOG-1','employee-1','employee-1','service-desk','INC-PC','INC',1,
    'Private title','Private content','{}','INDIVIDUAL','LOW','P4','CLOSED')`,[ticket]);
  await pool.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,request_id) VALUES($1,$2,$3,'CONFIRM','CLOSED','fixture-request')`,[event,ticket,admin.id]);
  await pool.query(`INSERT INTO audit_logs(ticket_id,event_id,actor_id,action,request_id,before_value,after_value)
    VALUES($1,$2,$3,'CONFIRM','fixture-request','{"status":"RESOLVED","description":"private-before"}',
    '{"status":"CLOSED","description":"private-after","token":"fixture-secret"}')`,[ticket,event,admin.id]);
  const timeline=JSON.stringify((await pool.query('SELECT * FROM ticket_events WHERE ticket_id=$1',[ticket])).rows);
  const ticketLog=(await logs.list(admin,{module:'tickets',q:'FIXTURE-LOG-1'})).items[0];
  const detail=await logs.detail(admin,ticketLog.id);
  assert.deepEqual(detail.changes,[{field:'status',before:'RESOLVED',after:'CLOSED'}]);
  assert.equal(JSON.stringify(detail).includes('private-after'),false);
  assert.equal(JSON.stringify(detail).includes('fixture-secret'),false);
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM ticket_events WHERE ticket_id=$1',[ticket])).rows),timeline);
  for(const id of ['employee-1','agent-1'])await assert.rejects(logs.list(identity(id),{}),e=>e.getStatus()===404);
  await assert.rejects(logs.detail(identity('employee-1'),ticketLog.id),e=>e.getStatus()===404);
  await assert.rejects(logs.detail(admin,'invalid/id'),e=>e.getStatus()===404);
  await pool.query("UPDATE employees SET active=false WHERE id=$1",[admin.id]);
  await assert.rejects(logs.list(admin,{}),e=>e.getStatus()===404);
  await pool.query("UPDATE employees SET active=true WHERE id=$1",[admin.id]);
  await pool.query("UPDATE role_bindings SET valid_from=now()-interval '2 days',valid_to=now()-interval '1 day' WHERE employee_id=$1",[admin.id]);
  await assert.rejects(logs.list(admin,{}),e=>e.getStatus()===404);
  await assert.rejects(pool.query("DELETE FROM operation_log_entries WHERE module='tickets'"),e=>e.code==='55000');
  console.log('PASS centralized logs: migrations, deduplication, paging, literal filters, redaction, role expiry and unchanged ticket timeline');
}finally{
  await pool?.end();
  await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await control.end();
}
