import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {TicketsService} from '../../apps/api/dist/tickets.service.js';
import {SlaService} from '../../apps/api/dist/sla.service.js';
import {RoutingConfigService} from '../../apps/api/dist/routing-config.service.js';
import {initializeAutomaticDispatch,maintainAutomaticDispatch} from '../../packages/workflow/dist/index.js';
import {recoverOwnership} from '../../apps/worker/dist/ownership-recovery.js';
import {notificationRecipients,expandNotification} from '../../apps/worker/dist/notification-audience.js';

if(process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')throw new Error('DISPOSABLE_DATABASE_REQUIRED');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const control=new pg.Client({...connection,database:process.env.DB_NAME}),name=`itsm_auto_${randomUUID().replaceAll('-','')}`;
const actor=id=>({id,name:id,groups:[]}),admin=actor('demo-admin-1'),requester=actor('employee-1');
let pool,tickets,routing,db,structureVersion=1;
const cases=[];
async function check(label,fn){await fn();cases.push(label);console.log(`PASS ${label}`);}
const get=async id=>(await pool.query('SELECT * FROM tickets WHERE id=$1',[id])).rows[0];
const run=async id=>(await pool.query('SELECT * FROM automatic_dispatch_runs WHERE ticket_id=$1',[id])).rows[0];
const attempts=async id=>(await pool.query(`SELECT a.* FROM automatic_dispatch_attempts a JOIN automatic_dispatch_runs r ON r.id=a.run_id
  WHERE r.ticket_id=$1 ORDER BY a.id`,[id])).rows;
const create=async()=>tickets.create(requester,{serviceCode:'INC-BIZ',formVersion:1,subject:'Automatic dispatch integration test',
  description:'Synthetic incident in a disposable database',fields:{},impact:'INDIVIDUAL',urgency:'MEDIUM',contentClass:'GENERAL'},randomUUID(),randomUUID());
async function action(id,who,kind,extra={},key=randomUUID()){
  const ticket=await get(id);return tickets.action(actor(who),id,{action:kind,expectedVersion:ticket.version,contentClass:'GENERAL',...extra},key,randomUUID());
}
const primary={id:randomUUID(),positionId:'auto-position',employeeId:'agent-1',duty:'PRIMARY',validFrom:'2020-01-01T00:00:00Z',validTo:null,enabled:true};
const backup={...primary,id:randomUUID(),employeeId:'agent-3',duty:'BACKUP'};
const config={domains:[{id:'auto-domain',name:'Automatic dispatch domain',enabled:true}],systems:[],
  positions:[{id:'auto-position',name:'Automatic dispatch position',domainId:'auto-domain',groupId:'service-desk',enabled:true}],
  appointments:[primary,backup],mappings:[{serviceCode:'INC-BIZ',domainId:'auto-domain',primaryPositionId:'auto-position',collaboratingPositionIds:[],enabled:true}]};
async function structure(appointments=[primary,backup]){
  structureVersion++;await pool.query('INSERT INTO service_structure_versions(version,config) VALUES($1,$2)',[structureVersion,JSON.stringify({...config,appointments})]);
  await pool.query('UPDATE service_structure_current SET version=$1',[structureVersion]);
}
async function policy(enabled=true,minutes=2){
  const current=(await routing.automatic(admin)).items.find(x=>x.code==='INC-BIZ');
  return routing.saveAutomatic(admin,{serviceCode:'INC-BIZ',expectedVersion:current.version,enabled,primaryMinutes:minutes,backupMinutes:3,
    reason:'Disposable automatic dispatch acceptance',contentClass:'GENERAL'});
}
async function expire(id){await pool.query("UPDATE tickets SET assignment_due_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);}
async function close(id,who){
  await action(id,who,'RESOLVE',{comment:'Service restored',resolutionCategory:'FIX',evidence:'Synthetic verification completed'});
  await action(id,'employee-1','CONFIRM',{comment:'Restoration confirmed'});assert.equal((await get(id)).status,'CLOSED');
}
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migrated=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr||migrated.stdout);
  pool=new pg.Pool({...connection,database:name,max:25});
  db={pool,transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  tickets=new TicketsService(db,{},new SlaService(),{requireGeneral:async()=>{}});
  routing=new RoutingConfigService(db,{requireGeneral:async()=>{}});
  await structure();
  let legacy;
  await check('Disabled by default; existing tickets retain manual routing',async()=>{
    legacy=await create();assert.equal((await get(legacy.id)).pending_assignee_id,null);assert.equal(await run(legacy.id),undefined);
    await policy();await maintainAutomaticDispatch(pool);assert.equal(await run(legacy.id),undefined);
  });
  await check('Primary receives first offer, other engineers cannot claim; accepted ticket closes normally',async()=>{
    const t=await create(),row=await get(t.id);assert.equal(row.pending_assignee_id,'agent-1');assert.equal(row.assignee_id,null);
    await assert.rejects(action(t.id,'agent-3','ACCEPT',{comment:'Cannot steal reserved offer'}));
    await action(t.id,'agent-1','ACCEPT_OFFER',{comment:'Primary accepts'});assert.equal((await run(t.id)).state,'ACCEPTED');
    await close(t.id,'agent-1');assert.equal((await attempts(t.id))[0].state,'ACCEPTED');
  });
  await check('Primary decline transfers atomically to backup; retries do not duplicate offers',async()=>{
    const t=await create(),before=await get(t.id),key=randomUUID();
    const body={action:'DECLINE_OFFER',expectedVersion:before.version,reason:'Primary unavailable',contentClass:'GENERAL'};
    const result=await tickets.action(actor('agent-1'),t.id,body,key,randomUUID());
    assert.deepEqual(await tickets.action(actor('agent-1'),t.id,body,key,randomUUID()),result);
    assert.equal((await get(t.id)).pending_assignee_id,'agent-3');assert.deepEqual((await attempts(t.id)).map(x=>x.state),['DECLINED','PENDING']);
    await assert.rejects(action(t.id,'agent-1','ACCEPT_OFFER',{comment:'Late primary'}));
    await action(t.id,'agent-3','ACCEPT_OFFER',{comment:'Backup accepts'});await close(t.id,'agent-3');
  });
  await check('Expired primary cannot accept; concurrent schedulers create exactly one backup offer without resetting SLA',async()=>{
    const t=await create(),sla=(await pool.query('SELECT * FROM sla_cycles WHERE ticket_id=$1',[t.id])).rows;
    await expire(t.id);await assert.rejects(action(t.id,'agent-1','ACCEPT_OFFER',{comment:'Expired offer'}));
    await Promise.all(Array.from({length:12},()=>maintainAutomaticDispatch(pool)));
    assert.equal((await get(t.id)).pending_assignee_id,'agent-3');assert.deepEqual((await attempts(t.id)).map(x=>x.state),['EXPIRED','PENDING']);
    assert.deepEqual((await pool.query('SELECT * FROM sla_cycles WHERE ticket_id=$1',[t.id])).rows,sla);
    await action(t.id,'agent-3','ACCEPT_OFFER',{comment:'Backup accepts after timeout'});await close(t.id,'agent-3');
  });
  await check('Both declines raise one actionable escalation; legacy recovery preserves it; dispatcher rescues and closes',async()=>{
    const t=await create();await action(t.id,'agent-1','DECLINE_OFFER',{reason:'Primary unavailable'});
    await action(t.id,'agent-3','DECLINE_OFFER',{reason:'Backup unavailable'});
    assert.equal((await run(t.id)).state,'ESCALATED');assert.equal((await get(t.id)).assignee_id,null);
    await maintainAutomaticDispatch(pool);await recoverOwnership(pool,async()=>{});
    const alert=(await pool.query('SELECT * FROM ticket_routing_alerts WHERE ticket_id=$1',[t.id])).rows[0];
    assert.equal(alert.reason,'AUTO_DISPATCH_EXHAUSTED');assert.equal(alert.resolved_at,null);
    const events=(await pool.query("SELECT * FROM ticket_events WHERE ticket_id=$1 AND action='OWNERSHIP_ESCALATION_REQUIRED'",[t.id])).rows;
    assert.equal(events.length,1);
    const client=await pool.connect();try{const recipients=await notificationRecipients(client,events[0].id);
      assert.ok(recipients.includes('agent-1'));assert.ok(recipients.includes('demo-admin-1'));assert.ok(!recipients.includes('employee-1'));}finally{client.release();}
    await action(t.id,'agent-1','ACCEPT',{comment:'Dispatcher takes responsibility'});
    assert.ok((await pool.query('SELECT resolved_at FROM ticket_routing_alerts WHERE ticket_id=$1',[t.id])).rows[0].resolved_at);
    await close(t.id,'agent-1');
  });
  await check('Both timeouts escalate once; no repeat offers to attempted engineers',async()=>{
    const t=await create();await expire(t.id);await maintainAutomaticDispatch(pool);await expire(t.id);await maintainAutomaticDispatch(pool);
    await maintainAutomaticDispatch(pool);assert.equal((await run(t.id)).state,'ESCALATED');
    assert.deepEqual((await attempts(t.id)).map(x=>x.state),['EXPIRED','EXPIRED']);
    assert.equal((await pool.query("SELECT count(*)::int n FROM ticket_events WHERE ticket_id=$1 AND action='OWNERSHIP_ESCALATION_REQUIRED'",[t.id])).rows[0].n,1);
    await action(t.id,'employee-1','CANCEL',{reason:'Synthetic test completed'});
  });
  await check('Appointment revoked while offered transfers to current eligible backup',async()=>{
    const t=await create();await structure([{...primary,enabled:false},backup]);await maintainAutomaticDispatch(pool);
    assert.equal((await get(t.id)).pending_assignee_id,'agent-3');assert.equal((await attempts(t.id))[0].state,'INVALIDATED');
    await action(t.id,'agent-3','ACCEPT_OFFER',{comment:'Eligible backup accepts'});await close(t.id,'agent-3');await structure();
  });
  await check('No active primary goes directly to backup; no eligible candidates escalates immediately',async()=>{
    await structure([{...primary,enabled:false},backup]);const t=await create();assert.equal((await get(t.id)).pending_assignee_id,'agent-3');
    await action(t.id,'employee-1','CANCEL',{reason:'Synthetic cleanup'});
    await structure([{...primary,enabled:false},{...backup,enabled:false}]);
    // Intake correctly rejects unavailable services; simulate a staffing loss after submission instead.
    await structure();const lost=await create();await structure([{...primary,enabled:false},{...backup,enabled:false}]);
    await maintainAutomaticDispatch(pool);assert.equal((await run(lost.id)).state,'ESCALATED');
    assert.equal((await get(lost.id)).pending_assignee_id,null);await structure();
  });
  await check('Manual offer cancellation stops automation; requester cancellation cancels pending attempt',async()=>{
    const manual=await create();await action(manual.id,'agent-1','CANCEL_OFFER',{reason:'Dispatcher changes plan'});
    await maintainAutomaticDispatch(pool);assert.equal((await run(manual.id)).state,'MANUAL');assert.equal((await get(manual.id)).pending_assignee_id,null);
    const cancelled=await create();await action(cancelled.id,'employee-1','CANCEL',{reason:'No longer needed'});
    await maintainAutomaticDispatch(pool);assert.equal((await run(cancelled.id)).state,'STOPPED');assert.equal((await attempts(cancelled.id))[0].state,'CANCELLED');
  });
  await check('Policy snapshot survives reconfiguration and disabled policy only affects new tickets',async()=>{
    const t=await create();await policy(false,7);await expire(t.id);await maintainAutomaticDispatch(pool);
    assert.equal((await get(t.id)).pending_assignee_id,'agent-3');assert.equal((await run(t.id)).snapshot.primaryMinutes,2);
    assert.equal(await run((await create()).id),undefined);await policy();
  });
  await check('Current offer notification survives unrelated version change; old primary is suppressed after transfer; outbox deduplicates',async()=>{
    await structure([{...backup,duty:'PRIMARY'},{...primary,duty:'BACKUP'}]);
    const t=await create();const event=(await pool.query("SELECT * FROM ticket_events WHERE ticket_id=$1 AND action='ASSIGN_OFFER'",[t.id])).rows[0];
    await pool.query('UPDATE tickets SET version=version+1 WHERE id=$1',[t.id]);
    const client=await pool.connect();try{
      assert.ok((await notificationRecipients(client,event.id)).includes('agent-3'));
      await action(t.id,'agent-3','DECLINE_OFFER',{reason:'Transfer notification recipient'});
      assert.ok(!(await notificationRecipients(client,event.id)).includes('agent-3'),'old candidate must not remain a pending recipient');
      const current=(await pool.query("SELECT e.id,o.id AS outbox_id FROM ticket_events e JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id=$1 AND e.action='ASSIGN_OFFER' ORDER BY e.created_at DESC LIMIT 1",[t.id])).rows[0];
      await expandNotification(client,current.outbox_id,current.id);await expandNotification(client,current.outbox_id,current.id);
      const deliveries=(await pool.query('SELECT employee_id,count(*)::int n FROM notification_deliveries WHERE outbox_id=$1 GROUP BY employee_id',[current.outbox_id])).rows;
      assert.ok(deliveries.some(x=>x.employee_id==='agent-1'));assert.ok(deliveries.every(x=>x.n===1));
    }finally{client.release();}
    await structure();
  });
  await check('Approval waiting state never invites engineers until approved',async()=>{
    await policy(false);const t=await create();await policy();
    await pool.query("UPDATE tickets SET status='WAITING_APPROVAL' WHERE id=$1",[t.id]);
    await db.transaction(c=>initializeAutomaticDispatch(c,t.id));
    await maintainAutomaticDispatch(pool);assert.equal((await get(t.id)).pending_assignee_id,null);
    assert.equal((await attempts(t.id)).length,0);
    await pool.query("UPDATE tickets SET status='IN_PROGRESS' WHERE id=$1",[t.id]);
    await maintainAutomaticDispatch(pool);assert.equal((await get(t.id)).pending_assignee_id,'agent-1');
  });
  await check('Admin-only configuration, optimistic concurrency, immutable history and audit/outbox integrity',async()=>{
    const current=(await routing.automatic(admin)).items.find(x=>x.code==='INC-BIZ');
    const input={serviceCode:'INC-BIZ',expectedVersion:current.version,enabled:true,primaryMinutes:2,backupMinutes:3,reason:'Concurrent config test',contentClass:'GENERAL'};
    await assert.rejects(routing.saveAutomatic(requester,input));await assert.rejects(routing.saveAutomatic(admin,{...input,primaryMinutes:0}));
    const saved=await Promise.allSettled([routing.saveAutomatic(admin,input),routing.saveAutomatic(admin,input)]);
    assert.equal(saved.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(saved.find(x=>x.status==='rejected').reason.getResponse().code,'AUTOMATIC_DISPATCH_VERSION_CONFLICT');
    await assert.rejects(pool.query('UPDATE automatic_dispatch_policies SET enabled=false'));
    await assert.rejects(pool.query('DELETE FROM automatic_dispatch_policies'));
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ticket_events e WHERE e.detail->>'automatic'='true'
      AND (NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.event_id=e.id) OR NOT EXISTS(SELECT 1 FROM outbox_events o WHERE o.event_id=e.id))`)).rows[0].n,0);
  });
  console.log(JSON.stringify({result:'PASS',cases:cases.length,checks:cases}));
}finally{
  if(pool)await pool.end();
  await control.query(`DROP DATABASE IF EXISTS ${name}`);await control.end();
}
