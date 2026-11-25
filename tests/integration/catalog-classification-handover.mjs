import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {TicketsService} from '../../apps/api/dist/tickets.service.js';
import {CatalogNavigationService} from '../../apps/api/dist/catalog-navigation.service.js';
import {WorkspaceController} from '../../apps/api/dist/workspace.controller.js';
import {SlaService} from '../../apps/api/dist/sla.service.js';
import {recoverOwnership} from '../../apps/worker/dist/ownership-recovery.js';
import {expireAssignments} from '../../apps/worker/dist/assignment-expiry.js';

if(process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')
  throw new Error('DISPOSABLE_DATABASE_REQUIRED');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const control=new pg.Client({...connection,database:process.env.DB_NAME});
const name=`itsm_classification_${randomUUID().replaceAll('-','')}`;
const actor=id=>({id,name:id,groups:[]});
const requester=actor('employee-1'),desk=actor('agent-1'),engineer=actor('agent-2'),admin=actor('demo-admin-1');
let pool;
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migrated=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr||migrated.stdout);
  pool=new pg.Pool({...connection,database:name});
  const db={pool,transaction:async fn=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }};
  const intake={requireGeneral:async()=>{}};
  const tickets=new TicketsService(db,{},new SlaService(),intake);
  const navigation=new CatalogNavigationService(db,intake);
  await pool.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id,name,required_fields,field_schema)
    VALUES('INC-ERP','INC',1,true,'applications','ERP故障','[]','[]'),
    ('INC-DESK','INC',1,true,'service-desk','服务台故障','[]','[]')`);
  await pool.query(`INSERT INTO assignment_policy_versions(group_id,priority,receive_minutes,calendar_snapshot,valid_from,valid_to,
    proposed_by,approved_by,approved_at,active) VALUES('applications','P3',60,
    '{"timeZone":"Asia/Shanghai","startHour":9,"endHour":18,"holidays":[],"workdays":[]}',
    now()-interval '1 day',now()+interval '30 days','demo-admin-1','demo-admin-2',now(),true)`);
  const appointments=[['agent-1','desk-position'],['agent-2','erp-position']].map(([employeeId,positionId])=>({
    id:randomUUID(),positionId,employeeId,duty:'PRIMARY',validFrom:'2020-01-01T00:00:00Z',validTo:'2030-01-01T00:00:00Z',enabled:true}));
  const config={domains:[{id:'desk-domain',name:'Helpdesk',enabled:true},{id:'app-domain',name:'Applications',enabled:true}],
    systems:[{id:'erp-system',name:'ERP',domainId:'app-domain',enabled:true}],
    positions:[{id:'desk-position',name:'Helpdesk',domainId:'desk-domain',groupId:'service-desk',enabled:true},
      {id:'erp-position',name:'ERP engineer',domainId:'app-domain',groupId:'applications',enabled:true}],appointments,
    mappings:[{serviceCode:'INC-BIZ',domainId:'desk-domain',primaryPositionId:'desk-position',collaboratingPositionIds:[],enabled:true},
      {serviceCode:'INC-DESK',domainId:'desk-domain',primaryPositionId:'desk-position',collaboratingPositionIds:[],enabled:true},
      {serviceCode:'INC-ERP',domainId:'app-domain',systemId:'erp-system',primaryPositionId:'erp-position',collaboratingPositionIds:[],enabled:true}]};
  await pool.query('INSERT INTO service_structure_versions(version,config) VALUES(2,$1)',[JSON.stringify(config)]);
  await pool.query('UPDATE service_structure_current SET version=2');
  const view=await navigation.tree(admin);
  const treeBody={expectedVersion:view.version,navigationVersion:view.navigationVersion,structureVersion:view.structureVersion,
    nodes:view.nodes,reason:'Disposable ERP directory',contentClass:'GENERAL'};
  const preview=await navigation.previewTree(admin,treeBody);
  assert.deepEqual(preview.items.find(item=>item.serviceCode==='INC-ERP').path.map(node=>node.name),
    ['信息化系统','ERP系统','登录与使用故障']);
  await navigation.saveTree(admin,treeBody);
  const row=async id=>(await pool.query('SELECT * FROM tickets WHERE id=$1',[id])).rows[0];
  const action=async(id,who,kind,extra={})=>tickets.action(actor(who),id,{action:kind,expectedVersion:(await row(id)).version,
    contentClass:'GENERAL',...extra},randomUUID(),randomUUID());
  const create=async()=>tickets.create(requester,{serviceCode:'INC-BIZ',formVersion:1,
    subject:'ERP entry cannot be used',description:'Synthetic classification handover in disposable database',
    fields:{system:'ERP'},impact:'INDIVIDUAL',urgency:'MEDIUM',contentClass:'GENERAL'},randomUUID(),randomUUID());
  const classify=async(id,extra={})=>tickets.classify(desk,id,{expectedVersion:(await row(id)).version,
    serviceCode:'INC-ERP',formVersion:1,fields:{},reason:'Confirmed ERP incident',targetAssigneeId:engineer.id,
    contentClass:'GENERAL',...extra},randomUUID(),randomUUID());
  const offer=async()=>{const ticket=await create();await action(ticket.id,desk.id,'ACCEPT',{comment:'Triage started'});
    const before=await row(ticket.id);await classify(ticket.id);return {id:ticket.id,before};};
  const queued=await create();
  await assert.rejects(tickets.classificationCandidates(engineer,queued.id,{serviceCode:'INC-DESK',formVersion:1,fields:{}}),
    error=>error.getStatus()===404,'unrelated engineers must not learn whether a queued ticket exists');
  const sameGroup=await tickets.classificationCandidates(desk,queued.id,{serviceCode:'INC-DESK',formVersion:1,fields:{}});
  assert.equal(sameGroup.crossGroup,false);
  await tickets.classify(desk,queued.id,{expectedVersion:(await row(queued.id)).version,serviceCode:'INC-DESK',
    formVersion:1,fields:{},reason:'Queued desk triage',contentClass:'GENERAL'},randomUUID(),randomUUID());
  assert.equal((await row(queued.id)).service_code,'INC-DESK');
  assert.equal((await row(queued.id)).assignee_id,null);
  const workspace=new WorkspaceController(db,{identity:async()=>requester},{},{},{});
  const beforeDisable=await create();
  const current=await navigation.tree(admin);
  const genericLeaf=current.nodes.find(n=>n.serviceCode==='INC-BIZ');
  const genericParent=current.nodes.find(n=>n.id===genericLeaf.parentId);
  const disabled={expectedVersion:current.version,navigationVersion:current.navigationVersion,
    structureVersion:current.structureVersion,contentClass:'GENERAL',reason:'Temporarily disable generic category',
    nodes:current.nodes.map(n=>n.id===genericLeaf.id||n.id===genericParent.id?{...n,enabled:false}:n)};
  await navigation.saveTree(admin,disabled);
  assert.equal((await workspace.catalog({})).items.some(item=>item.code==='INC-BIZ'),false);
  await assert.rejects(create(),error=>error.getResponse().code==='DIRECTORY_DISABLED');
  await assert.rejects(navigation.saveTree(admin,treeBody),error=>error.getResponse().code==='CATALOG_TREE_VERSION_CONFLICT');
  const restore=await navigation.tree(admin);
  await navigation.saveTree(admin,{expectedVersion:restore.version,navigationVersion:restore.navigationVersion,
    structureVersion:restore.structureVersion,contentClass:'GENERAL',reason:'Restore generic category',
    nodes:restore.nodes.map(n=>n.id===genericLeaf.id||n.id===genericParent.id?{...n,enabled:true}:n)});
  assert.equal((await workspace.catalog({})).items.some(item=>item.code==='INC-BIZ'),true);
  await action(beforeDisable.id,desk.id,'ACCEPT',{comment:'Existing incident remains actionable'});
  await action(beforeDisable.id,desk.id,'RESOLVE',{comment:'Resolved',resolutionCategory:'FIX',evidence:'Verified in test'});
  await action(beforeDisable.id,requester.id,'CONFIRM',{comment:'Confirmed'});
  assert.equal((await row(beforeDisable.id)).status,'CLOSED');
  const unchanged=async(id,before)=>{
    const current=await row(id);
    assert.equal(current.service_code,'INC-BIZ');assert.equal(current.owner_group_id,'service-desk');
    assert.equal(current.assignee_id,desk.id);assert.deepEqual(current.original_navigation_snapshot,before.original_navigation_snapshot);
    assert.deepEqual(current.navigation_snapshot,before.navigation_snapshot);
  };
  let ticket=await create();
  assert.deepEqual((await row(ticket.id)).navigation_snapshot.path.map(node=>node.name),
    ['信息化系统','其他或不确定系统','业务系统故障待分类']);
  await assert.rejects(classify(ticket.id),error=>error.getResponse().code==='CLASSIFICATION_OWNER_MUST_CLAIM');
  await action(ticket.id,desk.id,'ACCEPT',{comment:'Triage started'});
  const original=await row(ticket.id);
  await assert.rejects(classify(ticket.id,{targetAssigneeId:undefined}),error=>error.getResponse().code==='CLASSIFICATION_TARGET_REQUIRED');
  const candidates=await tickets.classificationCandidates(desk,ticket.id,{serviceCode:'INC-ERP',formVersion:1,fields:{}});
  assert.equal(candidates.crossGroup,true);assert.deepEqual(candidates.items.map(item=>item.id),[engineer.id]);
  await classify(ticket.id);
  let pending=await row(ticket.id);
  assert.equal(pending.pending_classification.serviceCode,'INC-ERP');assert.equal(pending.pending_group_id,'applications');
  await unchanged(ticket.id,original);
  assert.equal((await pool.query('SELECT count(*)::int n FROM sla_cycles WHERE ticket_id=$1',[ticket.id])).rows[0].n,1);
  await assert.rejects(action(ticket.id,requester.id,'CONFIRM'),error=>error.getResponse().code==='INVALID_TRANSITION');
  await action(ticket.id,engineer.id,'ACCEPT_HANDOVER',{comment:'ERP engineer accepted'});
  let accepted=await row(ticket.id);
  assert.equal(accepted.owner_group_id,'applications');assert.equal(accepted.assignee_id,engineer.id);
  assert.equal(accepted.service_code,'INC-ERP');assert.equal(accepted.pending_classification,null);
  assert.deepEqual(accepted.navigation_snapshot.path.map(node=>node.name),
    ['信息化系统','ERP系统','登录与使用故障']);
  assert.deepEqual(accepted.original_navigation_snapshot,original.original_navigation_snapshot);
  assert.equal((await pool.query('SELECT count(*)::int n FROM sla_cycles WHERE ticket_id=$1',[ticket.id])).rows[0].n,1);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id
    JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id=$1 AND e.action='CLASSIFICATION_CORRECTED'`,[ticket.id])).rows[0].n,1);
  await action(ticket.id,engineer.id,'RESOLVE',{comment:'ERP restored',resolutionCategory:'FIX',evidence:'Verified in test'});
  await action(ticket.id,requester.id,'CONFIRM',{comment:'Confirmed'});
  assert.equal((await row(ticket.id)).status,'CLOSED');

  const supplemented=await create();
  await action(supplemented.id,desk.id,'ACCEPT',{comment:'Investigating ERP report'});
  await action(supplemented.id,desk.id,'REQUEST_INFO',{comment:'Which page fails?',
    waitingReason:'USER_INFORMATION',dueAt:new Date(Date.now()+3600000).toISOString()});
  await classify(supplemented.id);
  const pendingBeforeInfo=await row(supplemented.id);
  await action(supplemented.id,requester.id,'ADD_INFO',{comment:'The ERP order entry page fails'});
  const pendingAfterInfo=await row(supplemented.id);
  assert.equal(pendingAfterInfo.status,'IN_PROGRESS');
  assert.deepEqual(pendingAfterInfo.pending_classification,pendingBeforeInfo.pending_classification);
  assert.equal(pendingAfterInfo.pending_assignee_id,engineer.id);
  await action(supplemented.id,engineer.id,'ACCEPT_HANDOVER',{comment:'ERP engineer accepted after follow-up'});
  assert.equal((await row(supplemented.id)).service_code,'INC-ERP');
  await action(supplemented.id,engineer.id,'RESOLVE',{comment:'ERP restored',resolutionCategory:'FIX',evidence:'Verified in test'});
  await action(supplemented.id,requester.id,'CONFIRM',{comment:'Confirmed'});
  assert.equal((await row(supplemented.id)).status,'CLOSED');

  const assigned=await create();
  assert.equal((await tickets.get(admin,assigned.id)).canAssignOffer,true);
  assert.deepEqual((await tickets.assignmentCandidates(admin,assigned.id,'service-desk')).items.map(item=>item.id),[desk.id]);
  await action(assigned.id,admin.id,'ASSIGN_OFFER',{targetGroupId:'service-desk',targetAssigneeId:desk.id,
    reason:'Administrator routed unclaimed ticket'});
  const offered=await row(assigned.id);
  assert.equal(offered.assignee_id,null);
  assert.equal(offered.pending_assignee_id,desk.id);
  await action(assigned.id,desk.id,'ACCEPT_OFFER',{comment:'Accepted assignment'});
  assert.equal((await row(assigned.id)).assignee_id,desk.id);
  await action(assigned.id,desk.id,'RESOLVE',{comment:'Restored',resolutionCategory:'FIX',evidence:'Verified in test'});
  await action(assigned.id,requester.id,'CONFIRM',{comment:'Confirmed'});
  assert.equal((await row(assigned.id)).status,'CLOSED');

  for(const [label,end] of [['decline',async id=>action(id,engineer.id,'DECLINE_HANDOVER',{reason:'Wrong engineer'})],
    ['cancel',async id=>action(id,desk.id,'CANCEL_HANDOVER',{reason:'Triage revised'})],
    ['timeout',async id=>{
      await pool.query("UPDATE tickets SET assignment_due_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
      await expireAssignments(pool,async(client,current,kind,detail)=>{
        await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id)
          VALUES($1,$2,'system:scheduler',$3,$4,$4,$5,$6)`,
          [randomUUID(),current.id,kind,current.status,JSON.stringify(detail),randomUUID()]);
      });
    }],
    ['appointment revoked',async id=>{
      await pool.query('UPDATE service_structure_current SET version=3');
      await recoverOwnership(pool,async()=>{});
      await pool.query('UPDATE service_structure_current SET version=2');
    }]]){
    const {id,before}=await offer();
    if(label==='appointment revoked'){
      const revoked={...config,appointments:appointments.filter(a=>a.employeeId!==engineer.id)};
      await pool.query('INSERT INTO service_structure_versions(version,config) VALUES(3,$1)',[JSON.stringify(revoked)]);
    }
    await end(id);await unchanged(id,before);
    const after=await row(id);
    assert.equal(after.pending_assignee_id,null,label);
    assert.equal(after.pending_classification,null,label);
    await action(id,desk.id,'RESOLVE',{comment:'Resolved at service desk',resolutionCategory:'FIX',evidence:'Verified in test'});
    await action(id,requester.id,'CONFIRM',{comment:'Confirmed'});
    assert.equal((await row(id)).status,'CLOSED',label);
  }
  await pool.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id,name,required_fields,field_schema)
    VALUES('INC-NEW-DRAFT','INC',1,false,'service-desk','New service','[]','[]')`);
  const withNewService=await navigation.tree(admin);
  await assert.rejects(navigation.saveTree(admin,{expectedVersion:withNewService.version,
    navigationVersion:withNewService.navigationVersion,structureVersion:withNewService.structureVersion,
    nodes:withNewService.nodes,reason:'Reject unbound service',contentClass:'GENERAL'}),
  error=>error.getResponse().code==='CATALOG_TREE_SERVICE_UNASSIGNED');
  const parent=withNewService.nodes.find(n=>n.kind==='CATEGORY'&&n.parentId===null&&n.name==='其他服务');
  await navigation.saveTree(admin,{expectedVersion:withNewService.version,
    navigationVersion:withNewService.navigationVersion,structureVersion:withNewService.structureVersion,
    nodes:[...withNewService.nodes,{id:'new-draft-service',parentId:parent.id,kind:'SERVICE',name:'New service',
      enabled:false,sortOrder:999,systemId:null,serviceCode:'INC-NEW-DRAFT'}],
    reason:'Bind new service as disabled draft',contentClass:'GENERAL'});
  assert.equal((await workspace.catalog({})).items.some(item=>item.code==='INC-NEW-DRAFT'),false);
  console.log('Catalog classification handover verified: ERP directory, disabled ancestors, new service binding, administrator assignment, follow-up during handover, atomic acceptance, rejection, cancellation, timeout, revocation, SLA, audit, resolution');
}finally{
  if(pool)await pool.end();
  let remaining;
  for(let attempt=0;attempt<40;attempt++){
    remaining=(await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0].count;
    if(remaining===0)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(remaining,0,'disposable database connections must close before cleanup');
  await control.query(`DROP DATABASE IF EXISTS ${name}`);await control.end();
}
