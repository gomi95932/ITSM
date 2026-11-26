import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {TicketsService} from '../../apps/api/dist/tickets.service.js';
import {SlaService} from '../../apps/api/dist/sla.service.js';
import {AuthService} from '../../apps/api/dist/auth.service.js';
import {RoutingConfigService} from '../../apps/api/dist/routing-config.service.js';
import {CatalogNavigationService} from '../../apps/api/dist/catalog-navigation.service.js';
import {ensureTriage,maintainTriage,maintainAutomaticDispatch} from '../../packages/workflow/dist/index.js';
import {recoverOwnership} from '../../apps/worker/dist/ownership-recovery.js';
import {expireAssignments} from '../../apps/worker/dist/assignment-expiry.js';
import {notificationRecipients} from '../../apps/worker/dist/notification-audience.js';

if(process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')throw new Error('DISPOSABLE_DATABASE_REQUIRED');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const control=new pg.Client({...connection,database:process.env.DB_NAME}),name=`itsm_triage_${randomUUID().replaceAll('-','')}`;
const actor=id=>({id,name:id,groups:[],canCoordinate:id.startsWith('triage-')});
const admin=actor('demo-admin-1'),requester=actor('employee-1'),coordinator=actor('triage-primary');
const intake={requireGeneral:async()=>{}};
let pool,db,tickets,routing;
const connectionClosures=[];
const cases=[];
async function check(label,fn){await fn();cases.push(label);console.log(`PASS ${label}`);}
const get=async id=>(await pool.query('SELECT * FROM tickets WHERE id=$1',[id])).rows[0];
const triage=async id=>(await pool.query('SELECT * FROM ticket_triage_responsibilities WHERE ticket_id=$1',[id])).rows[0];
const event=async(id,action)=>(await pool.query('SELECT * FROM ticket_events WHERE ticket_id=$1 AND action=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[id,action])).rows[0];
const sla=async id=>(await pool.query('SELECT to_jsonb(s) AS value FROM sla_cycles s WHERE ticket_id=$1 ORDER BY started_at',[id])).rows;
const create=async()=>tickets.create(requester,{serviceCode:'INC-BIZ',formVersion:1,subject:'Unified triage acceptance',
  description:'Synthetic incident in a disposable database',fields:{},impact:'INDIVIDUAL',urgency:'MEDIUM',contentClass:'GENERAL'},randomUUID(),randomUUID());
async function action(id,who,kind,extra={}){return tickets.action(actor(who),id,{action:kind,expectedVersion:(await get(id)).version,contentClass:'GENERAL',...extra},randomUUID(),randomUUID());}
async function save(changes={}){
  const current=(await routing.triage(admin)).policy;
  return routing.saveTriage(admin,{id:randomUUID(),expectedVersion:current?.version??0,enabled:true,
    primaryEmployeeId:'triage-primary',backupEmployeeId:'triage-backup',reminderMinutes:2,reason:'Synthetic triage configuration',contentClass:'GENERAL',...changes});
}
async function automatic(enabled){
  const current=(await routing.automatic(admin)).items.find(x=>x.code==='INC-BIZ');
  await routing.saveAutomatic(admin,{serviceCode:'INC-BIZ',expectedVersion:current.version,enabled,primaryMinutes:2,backupMinutes:2,
    reason:'Synthetic dispatch configuration',contentClass:'GENERAL'});
}
async function expireOffer(id){await pool.query("UPDATE tickets SET assignment_due_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);}
async function expireTriage(id){await pool.query("UPDATE ticket_triage_responsibilities SET due_at=clock_timestamp()-interval '1 second' WHERE ticket_id=$1",[id]);}
async function cancel(id){await action(id,'employee-1','CANCEL',{reason:'Synthetic cleanup'});}
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migration=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migration.status,0,migration.stderr||migration.stdout);
  pool=new pg.Pool({...connection,database:name,max:20});
  pool.on('connect',client=>connectionClosures.push(new Promise(resolve=>client.once('end',resolve))));
  db={pool,transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  tickets=new TicketsService(db,{},new SlaService(),intake);routing=new RoutingConfigService(db,intake);
  for(const id of ['triage-primary','triage-backup','triage-new']){
    await pool.query('INSERT INTO employees(id,display_name) VALUES($1,$1)',[id]);
    await pool.query("INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES('synthetic-corp',$1,$1)",[id]);
  }
  const appointment={id:randomUUID(),positionId:'triage-position',employeeId:'agent-1',duty:'PRIMARY',validFrom:'2020-01-01T00:00:00Z',validTo:null,enabled:true};
  await pool.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id,name,required_fields,field_schema)
    VALUES('INC-ERP','INC',1,true,'applications','Synthetic ERP','[]','[]')`);
  const structure={domains:[{id:'triage-domain',name:'Synthetic domain',enabled:true},{id:'app-domain',name:'Applications',enabled:true}],
    systems:[{id:'erp-system',name:'ERP',domainId:'app-domain',enabled:true}],
    positions:[{id:'triage-position',name:'Synthetic engineer',domainId:'triage-domain',groupId:'service-desk',enabled:true},
      {id:'erp-position',name:'ERP engineer',domainId:'app-domain',groupId:'applications',enabled:true}],
    appointments:[appointment,{...appointment,id:randomUUID(),employeeId:'agent-3',duty:'BACKUP'},
      {...appointment,id:randomUUID(),positionId:'erp-position',employeeId:'agent-2'}],
    mappings:[{serviceCode:'INC-BIZ',domainId:'triage-domain',primaryPositionId:'triage-position',collaboratingPositionIds:[],enabled:true},
      {serviceCode:'INC-ERP',domainId:'app-domain',systemId:'erp-system',primaryPositionId:'erp-position',collaboratingPositionIds:[],enabled:true}]};
  await pool.query('INSERT INTO service_structure_versions(version,config) VALUES(2,$1)',[JSON.stringify(structure)]);
  await pool.query('UPDATE service_structure_current SET version=2');
  const navigation=new CatalogNavigationService(db,intake),tree=await navigation.tree(admin);
  await navigation.saveTree(admin,{expectedVersion:tree.version,navigationVersion:tree.navigationVersion,
    structureVersion:tree.structureVersion,nodes:tree.nodes,reason:'Synthetic ERP catalog',contentClass:'GENERAL'});

  await check('Disabled fallback preserves the existing manual workflow',async()=>{
    const t=await create();assert.equal(await triage(t.id),undefined);await cancel(t.id);
  });
  await check('Admin configuration is validated, idempotent, versioned and immutable',async()=>{
    await assert.rejects(save({primaryEmployeeId:'employee-1'}),e=>e.getResponse().code==='TRIAGE_EMPLOYEE_UNAVAILABLE');
    await assert.rejects(save({backupEmployeeId:'triage-primary'}));
    const input={id:randomUUID(),expectedVersion:0,enabled:true,primaryEmployeeId:'triage-primary',backupEmployeeId:'triage-backup',
      reminderMinutes:2,reason:'Initial synthetic policy',contentClass:'GENERAL'};
    await assert.rejects(routing.saveTriage(requester,input));
    const first=await routing.saveTriage(admin,input);assert.equal(first.version,1);
    assert.deepEqual(await routing.saveTriage(admin,input),first);
    await assert.rejects(routing.saveTriage(admin,{...input,reason:'Different input'}),e=>e.getResponse().code==='TRIAGE_REQUEST_CONFLICT');
    await assert.rejects(pool.query('UPDATE triage_policy_versions SET enabled=false WHERE version=1'));
    const competing={...input,id:randomUUID(),expectedVersion:1};
    const results=await Promise.allSettled([routing.saveTriage(admin,competing),routing.saveTriage(admin,{...competing,id:randomUUID()})]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  });
  await check('An unassigned ticket reaches exactly one coordinator without altering SLA or original classification',async()=>{
    const t=await create(),before=await get(t.id),clock=await sla(t.id);
    assert.equal((await triage(t.id)).coordinator_id,'triage-primary');
    await Promise.all(Array.from({length:8},()=>db.transaction(c=>ensureTriage(c,t.id,'Concurrent recovery'))));
    assert.equal((await pool.query("SELECT count(*)::int n FROM ticket_events WHERE ticket_id=$1 AND action='TRIAGE_ASSIGNED'",[t.id])).rows[0].n,1);
    const detail=await tickets.get(coordinator,t.id);
    assert.equal(detail.triage.coordinatorId,'triage-primary');assert.equal(detail.assigneeId,null);
    assert.equal(detail.canAssignOffer,true);assert.equal(detail.canProcess,false);assert.equal(detail.canClaim,false);
    assert.deepEqual(await sla(t.id),clock);
    assert.deepEqual((await get(t.id)).original_navigation_snapshot,before.original_navigation_snapshot);
    await cancel(t.id);
  });
  await check('Coordination is ticket-scoped and never grants engineer or administrator powers',async()=>{
    const t=await create();
    await assert.rejects(tickets.get(actor('triage-backup'),t.id));
    await assert.rejects(routing.triage(coordinator));
    await assert.rejects(action(t.id,'triage-primary','ACCEPT',{comment:'Cannot become engineer'}));
    await assert.rejects(action(t.id,'triage-primary','RESOLVE',{comment:'No processing privilege',resolutionCategory:'FIX',evidence:'Synthetic'}));
    await assert.rejects(action(t.id,'triage-primary','ASSIGN_OFFER',{targetAssigneeId:'employee-1',reason:'Unqualified target'}));
    const candidates=await tickets.assignmentCandidates(coordinator,t.id,'service-desk');
    assert.deepEqual(candidates.items.map(x=>x.id).sort(),['agent-1','agent-3']);
    process.env.ENABLE_DEV_AUTH='true';
    const identity=await new AuthService(db).identity({devUser:'triage-primary'});
    assert.equal(identity.canCoordinate,true);assert.deepEqual(identity.groups,[]);assert.equal(identity.canManageRouting,false);
    await cancel(t.id);
  });
  await check('Coordinator assignment, engineer acceptance, resolution and requester closure form a complete chain',async()=>{
    const t=await create(),clock=await sla(t.id),message=await event(t.id,'TRIAGE_ASSIGNED');
    assert.deepEqual(await notificationRecipients(pool,message.id),['triage-primary']);
    await action(t.id,'triage-primary','ASSIGN_OFFER',{targetAssigneeId:'agent-1',reason:'Professional engineer identified'});
    assert.equal((await triage(t.id)).stage,'COMPLETED');
    assert.deepEqual(await notificationRecipients(pool,message.id),[]);
    await assert.rejects(tickets.get(coordinator,t.id));
    await maintainAutomaticDispatch(pool);await maintainTriage(pool);
    assert.equal((await get(t.id)).pending_assignee_id,'agent-1');
    await action(t.id,'agent-1','ACCEPT_OFFER',{comment:'Engineer accepted'});
    assert.deepEqual(await sla(t.id),clock);
    await action(t.id,'agent-1','RESOLVE',{comment:'Synthetic fault resolved',resolutionCategory:'FIX',evidence:'Synthetic check passed'});
    await action(t.id,'employee-1','CONFIRM',{comment:'Requester confirmed'});
    assert.equal((await get(t.id)).status,'CLOSED');
    await maintainTriage(pool);assert.equal((await triage(t.id)).stage,'COMPLETED');
  });
  await check('Expired manual invitations return to named triage without resetting the SLA',async()=>{
    const t=await create(),clock=await sla(t.id),first=await triage(t.id);
    await action(t.id,'triage-primary','ASSIGN_OFFER',{targetAssigneeId:'agent-1',reason:'Manual invitation expires'});
    await expireOffer(t.id);let expired=0;
    await expireAssignments(pool,async(_client,row,kind)=>{assert.equal(row.id,t.id);assert.equal(kind,'ASSIGNMENT_EXPIRED');expired++;});
    assert.equal(expired,1);assert.equal((await get(t.id)).pending_assignee_id,null);
    await recoverOwnership(pool,async()=>{throw new Error('UNEXPECTED_LEGACY_RECOVERY');});
    const returned=await triage(t.id);assert.equal(returned.coordinator_id,'triage-primary');
    assert.equal(returned.stage,'PRIMARY');assert.ok(returned.generation>first.generation);
    assert.equal((await tickets.get(coordinator,t.id)).canAssignOffer,true);
    assert.deepEqual(await sla(t.id),clock);await cancel(t.id);
  });
  await check('Coordinator timeout transfers to backup then escalates once; old notifications are discarded',async()=>{
    const t=await create(),first=await event(t.id,'TRIAGE_ASSIGNED');
    await expireTriage(t.id);await Promise.all(Array.from({length:6},()=>maintainTriage(pool)));
    assert.equal((await triage(t.id)).coordinator_id,'triage-backup');
    assert.deepEqual(await notificationRecipients(pool,first.id),[]);
    const transferred=await event(t.id,'TRIAGE_TRANSFERRED'),recipients=await notificationRecipients(pool,transferred.id);
    assert.ok(recipients.includes('triage-backup'));assert.ok(recipients.includes('demo-admin-1'));
    await assert.rejects(tickets.get(coordinator,t.id));await tickets.get(actor('triage-backup'),t.id);
    await expireTriage(t.id);await maintainTriage(pool);await maintainTriage(pool);
    assert.equal((await triage(t.id)).stage,'ESCALATED');assert.equal((await triage(t.id)).coordinator_id,null);
    assert.deepEqual(await notificationRecipients(pool,transferred.id),[]);
    assert.equal((await pool.query("SELECT count(*)::int n FROM ticket_events WHERE ticket_id=$1 AND action='TRIAGE_ESCALATED'",[t.id])).rows[0].n,1);
    assert.ok((await routing.triage(admin)).backlog.some(x=>x.ticket_id===t.id));
    await action(t.id,'demo-admin-1','ASSIGN_OFFER',{targetAssigneeId:'agent-3',reason:'Administrator rescue'});
    assert.equal((await get(t.id)).pending_assignee_id,'agent-3');await cancel(t.id);
  });
  await check('Coordinator corrects queued classification across groups without becoming the engineer',async()=>{
    const t=await create(),before=await get(t.id),clock=await sla(t.id);
    const candidates=await tickets.classificationCandidates(coordinator,t.id,{serviceCode:'INC-ERP',formVersion:1,fields:{}});
    assert.equal(candidates.crossGroup,false);
    await tickets.classify(coordinator,t.id,{expectedVersion:before.version,serviceCode:'INC-ERP',formVersion:1,fields:{},
      reason:'Confirmed ERP scope',contentClass:'GENERAL'},randomUUID(),randomUUID());
    const corrected=await get(t.id);
    assert.equal(corrected.service_code,'INC-ERP');assert.equal(corrected.owner_group_id,'applications');
    assert.equal(corrected.assignee_id,null);assert.equal(corrected.pending_assignee_id,null);
    assert.deepEqual(corrected.original_navigation_snapshot,before.original_navigation_snapshot);
    assert.deepEqual(await sla(t.id),clock);
    assert.deepEqual((await tickets.assignmentCandidates(coordinator,t.id,'applications')).items.map(x=>x.id),['agent-2']);
    await action(t.id,'triage-primary','ASSIGN_OFFER',{targetAssigneeId:'agent-2',reason:'ERP engineer assigned'});
    await action(t.id,'agent-2','ACCEPT_OFFER',{comment:'ERP accepted'});
    await action(t.id,'agent-2','RESOLVE',{comment:'ERP restored',resolutionCategory:'FIX',evidence:'Synthetic verification'});
    await action(t.id,'employee-1','CONFIRM',{comment:'Confirmed'});assert.equal((await get(t.id)).status,'CLOSED');
  });
  await check('Concurrent manual assignments and timeout scans retain one invitation and the original SLA',async()=>{
    const t=await create(),version=(await get(t.id)).version,clock=await sla(t.id);await expireTriage(t.id);
    const results=await Promise.allSettled(['agent-1','agent-3'].map(targetAssigneeId=>tickets.action(coordinator,t.id,
      {action:'ASSIGN_OFFER',expectedVersion:version,targetAssigneeId,reason:'Concurrent manual dispatch',contentClass:'GENERAL'},randomUUID(),randomUUID()))
      .concat([maintainTriage(pool)]));
    assert.ok(results.slice(0,2).filter(x=>x.status==='fulfilled').length<=1);
    if(!(await get(t.id)).pending_assignee_id)await action(t.id,'demo-admin-1','ASSIGN_OFFER',{targetAssigneeId:'agent-1',reason:'Administrator resolved race'});
    const current=await get(t.id);assert.ok(['agent-1','agent-3'].includes(current.pending_assignee_id));
    assert.equal((await triage(t.id)).stage,'COMPLETED');assert.deepEqual(await sla(t.id),clock);
    assert.equal((await pool.query("SELECT count(*)::int n FROM ticket_events WHERE ticket_id=$1 AND action='ASSIGN_OFFER'",[t.id])).rows[0].n,1);
    await cancel(t.id);
  });
  await check('Missing receiving policy and an already breached SLA cannot strand manual dispatch',async()=>{
    const t=await create();await pool.query("UPDATE tickets SET priority='P4' WHERE id=$1",[t.id]);
    await pool.query("UPDATE sla_cycles SET started_at=now()-interval '10 days',response_target=1,resolution_target=1 WHERE ticket_id=$1",[t.id]);
    const clock=await sla(t.id);assert.equal((await tickets.get(coordinator,t.id)).canAssignOffer,true);
    await action(t.id,'triage-primary','ASSIGN_OFFER',{targetAssigneeId:'agent-1',reason:'Overdue ticket still needs an engineer'});
    const offered=await get(t.id);assert.equal(offered.assignment_policy_version_id,null);
    assert.equal(offered.assignment_due_at-offered.assignment_offered_at,3600000);assert.deepEqual(await sla(t.id),clock);await cancel(t.id);
  });
  await check('Disabled coordinator moves to an active backup without waiting for the deadline',async()=>{
    const t=await create();await pool.query("UPDATE employees SET active=false WHERE id='triage-primary'");
    await maintainTriage(pool);assert.equal((await triage(t.id)).coordinator_id,'triage-backup');
    await pool.query("UPDATE employees SET active=true WHERE id='triage-primary'");await cancel(t.id);
  });
  await check('New policy leaves backlog snapshots intact; explicit transfer is audited and idempotent',async()=>{
    const t=await create(),snapshot=await triage(t.id),clock=await sla(t.id);
    const policy=await save({primaryEmployeeId:'triage-new'});
    await maintainTriage(pool);assert.equal((await triage(t.id)).policy_version,snapshot.policy_version);
    assert.equal((await triage(t.id)).coordinator_id,'triage-primary');
    const input={id:randomUUID(),ticketId:t.id,expectedVersion:(await get(t.id)).version,expectedPolicyVersion:policy.version,
      reason:'Explicit reassignment of backlog',contentClass:'GENERAL'};
    await assert.rejects(routing.transferTriage(coordinator,input));
    const moved=await routing.transferTriage(admin,input);assert.equal(moved.coordinator_id,'triage-new');
    assert.equal(moved.policy_version,policy.version);
    assert.deepEqual(JSON.parse(JSON.stringify(await routing.transferTriage(admin,input))),JSON.parse(JSON.stringify(moved)));
    assert.deepEqual(await sla(t.id),clock);await assert.rejects(tickets.get(coordinator,t.id));
    assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE ticket_id=$1 AND actor_id='demo-admin-1' AND action='TRIAGE_ASSIGNED'",[t.id])).rowCount);
    await save();await cancel(t.id);
  });
  await check('Normal automatic offers bypass triage; refusal exhaustion enters triage and rejects stale acceptance',async()=>{
    await automatic(true);const t=await create();assert.equal((await get(t.id)).pending_assignee_id,'agent-1');assert.equal(await triage(t.id),undefined);
    await action(t.id,'agent-1','DECLINE_OFFER',{reason:'Primary unavailable'});assert.equal((await get(t.id)).pending_assignee_id,'agent-3');
    await action(t.id,'agent-3','DECLINE_OFFER',{reason:'Backup unavailable'});
    assert.equal((await triage(t.id)).coordinator_id,'triage-primary');
    await assert.rejects(action(t.id,'agent-3','ACCEPT_OFFER',{comment:'Stale acceptance'}));
    await action(t.id,'triage-primary','ASSIGN_OFFER',{targetAssigneeId:'agent-1',reason:'Manual dispatch after contact'});
    await maintainAutomaticDispatch(pool);assert.equal((await get(t.id)).pending_assignee_id,'agent-1');await cancel(t.id);
  });
  await check('Both engineering offers expire into triage with unchanged SLA and original submission time',async()=>{
    const t=await create(),before=await get(t.id),clock=await sla(t.id);
    await expireOffer(t.id);await maintainAutomaticDispatch(pool);assert.equal((await get(t.id)).pending_assignee_id,'agent-3');
    await expireOffer(t.id);await maintainAutomaticDispatch(pool);
    assert.equal((await triage(t.id)).stage,'PRIMARY');assert.deepEqual(await sla(t.id),clock);
    assert.deepEqual((await get(t.id)).created_at,before.created_at);await cancel(t.id);
  });
  await check('Legacy exhausted dispatch is recovered after fallback becomes enabled',async()=>{
    await save({enabled:false});const t=await create();
    await action(t.id,'agent-1','DECLINE_OFFER',{reason:'Primary unavailable'});
    await action(t.id,'agent-3','DECLINE_OFFER',{reason:'Backup unavailable'});assert.equal(await triage(t.id),undefined);
    await save();await recoverOwnership(pool,async()=>{throw new Error('UNEXPECTED_LEGACY_RECOVERY');});assert.equal((await triage(t.id)).stage,'PRIMARY');await cancel(t.id);
  });
  await check('Waiting approval is never triaged, offered or bypassed; cancelled tickets stay untouched',async()=>{
    await automatic(false);await save({enabled:false});const t=await create();
    await pool.query("UPDATE tickets SET status='WAITING_APPROVAL' WHERE id=$1",[t.id]);await save();
    assert.equal(await db.transaction(c=>ensureTriage(c,t.id,'Approval guard')),false);
    await recoverOwnership(pool,async()=>{throw new Error('UNEXPECTED_LEGACY_RECOVERY');});assert.equal(await triage(t.id),undefined);assert.equal((await get(t.id)).pending_assignee_id,null);
    await pool.query("UPDATE tickets SET status='QUEUED' WHERE id=$1",[t.id]);await cancel(t.id);
    assert.equal(await db.transaction(c=>ensureTriage(c,t.id,'Terminal guard')),false);
  });
  await check('Administrator directly applies routing configuration while reviewed records still prohibit self-review',async()=>{
    const input={id:randomUUID(),kind:'ASSIGNMENT_POLICY',groupId:'service-desk',priority:'P4',expectedPolicyId:null,
      config:{enabled:true,receiveMinutes:60,calendar:{timeZone:'Asia/Shanghai',startHour:9,endHour:18,holidays:[],workdays:[]},
        validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString()},
      reason:'Direct administrator maintenance',contentClass:'GENERAL'};
    const applied=await routing.propose(admin,input,true);assert.equal(applied.status,'APPROVED');assert.equal(applied.managementMode,'ADMIN_DIRECT');
    assert.equal(applied.proposedBy,applied.reviewedBy);
    const policy=(await pool.query("SELECT * FROM assignment_policy_versions WHERE group_id='service-desk' AND priority='P4' AND active")).rows[0];
    assert.equal(policy.management_mode,'ADMIN_DIRECT');
    const pending=await routing.propose(admin,{...input,id:randomUUID(),expectedPolicyId:policy.id});
    await assert.rejects(routing.review(admin,pending.id,{expectedVersion:pending.version,decision:'APPROVE',reason:'Self review',contentClass:'GENERAL'}));
    assert.ok((await pool.query("SELECT 1 FROM operation_log_entries WHERE action='TRIAGE_POLICY_APPLIED'")).rowCount);
  });
  console.log(JSON.stringify({status:'passed',scenarios:cases.length,cases},null,2));
}finally{
  // Pool shutdown can resolve before every PostgreSQL socket has finished closing.
  if(pool)await pool.end();await Promise.all(connectionClosures);
  await control.query(`DROP DATABASE IF EXISTS ${name}`);await control.end();
}
