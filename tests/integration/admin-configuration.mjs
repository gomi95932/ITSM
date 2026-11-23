import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {RolesService} from '../../apps/api/dist/roles.service.js';
import {SupportService} from '../../apps/api/dist/support.service.js';
import {ServiceStructureService} from '../../apps/api/dist/service-structure.service.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')
  throw new Error('DISPOSABLE_ADMIN_CONFIGURATION_CI_ONLY');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,
  password:process.env.DB_PASSWORD,statement_timeout:30000};
const control=new pg.Client({...connection,database:process.env.DB_NAME});
const name=`itsm_admin_config_${randomUUID().replaceAll('-','')}`;
let pool;
const actor=id=>({id,name:id,groups:[]});
const admin=actor('demo-admin-1'),other=actor('demo-admin-2'),employee=actor('employee-1');
const basis={reason:'Disposable administrator configuration test',contentClass:'GENERAL'};
const fails=(promise,code)=>assert.rejects(promise,error=>error.getResponse?.().code===code,
  `Expected ${code}`);
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migrated=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr);
  pool=new pg.Pool({...connection,database:name});
  const db={pool,transaction:async fn=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }};
  const intake={requireGeneral:async()=>{}};
  const roles=new RolesService(db,intake),support=new SupportService(db,intake),structure=new ServiceStructureService(db,intake);
  const snapshot=async()=>JSON.stringify((await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM role_bindings x) roles,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM role_binding_audits x) role_audits,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM support_groups x) groups,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY employee_id,group_id) FROM group_memberships x) members,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM support_structure_proposals x) support,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM support_structure_audits x) support_audits,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY version) FROM service_structure_versions x) versions,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM service_structure_proposals x) proposals,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM service_structure_audits x) audits,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM operational_audits x) operations`)).rows);
  const group='admin-test';
  const create={id:randomUUID(),kind:'GROUP_CREATE',groupId:group,expectedGroupVersion:null,
    config:{name:'Administrator test support',description:'Disposable fixture'},...basis};
  const created=await support.propose(admin,create,true);
  assert.equal(created.status,'APPROVED');assert.equal(created.managementMode,'ADMIN_DIRECT');
  assert.equal(created.reviewedBy,admin.id);
  const saved=await snapshot();
  assert.equal((await support.propose(admin,create,true)).id,created.id);
  assert.equal(await snapshot(),saved,'direct support retry adds no changes');
  const groupVersion=async()=>(await pool.query('SELECT administration_version FROM support_groups WHERE id=$1',[group])).rows[0].administration_version;
  const selfMember={id:randomUUID(),kind:'MEMBER_ADD',groupId:group,employeeId:admin.id,
    expectedGroupVersion:await groupVersion(),config:{},...basis};
  assert.equal((await support.propose(admin,selfMember,true)).status,'APPROVED');
  await assert.rejects(support.propose(employee,{...create,id:randomUUID(),groupId:'forbidden'},true));
  const role=(person,roleCode,groupId)=>({id:randomUUID(),employeeId:person,roleCode,groupId,
    validFrom:new Date(Date.now()-1000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),...basis});
  const scoped=role(employee.id,'GROUP_LEAD',group);
  const binding=await roles.propose(admin,scoped,true);
  assert.equal(binding.status,'ACTIVE');assert.equal(binding.effective,true);
  assert.equal(binding.managementMode,'ADMIN_DIRECT');
  assert.equal((await pool.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2',[employee.id,group])).rowCount,1);
  const roleSaved=await snapshot();
  await roles.propose(admin,scoped,true);assert.equal(await snapshot(),roleSaved);
  await assert.rejects(roles.propose(employee,role('employee-2','DISPATCHER',group),true));
  await assert.rejects(support.propose(employee,{...selfMember,id:randomUUID(),employeeId:'employee-2',expectedGroupVersion:await groupVersion()},true));
  assert.equal((await roles.propose(admin,role(admin.id,'DISPATCHER',group),true)).effective,true);
  await fails(roles.propose(admin,role(admin.id,'GROUP_LEAD',group)), 'ROLE_SELF_GRANT_DENIED');
  await fails(roles.propose(admin,{...role('employee-2','DISPATCHER',group),managementMode:'ADMIN_DIRECT'},true),'INVALID_ROLE_BINDING');
  const legacy=await roles.propose(other,role('agent-3','GROUP_LEAD','service-desk'));
  assert.equal(legacy.status,'PENDING');
  await fails(roles.decide(other,legacy.id,{expectedVersion:legacy.version,decision:'APPROVE',...basis}),'ROLE_INDEPENDENT_REVIEW_REQUIRED');
  await roles.decide(admin,legacy.id,{expectedVersion:legacy.version,decision:'APPROVE',...basis});

  let current=await structure.list(admin);
  let config=structuredClone(current.config);
  config.domains.push({id:'admin-domain',name:'Infrastructure',enabled:true});
  config.systems.push({id:'admin-system',name:'Custom business system',domainId:'admin-domain',enabled:true});
  config.positions.push({id:'admin-position',name:'Service engineer',domainId:'admin-domain',groupId:group,enabled:true});
  const appointment=person=>({id:randomUUID(),positionId:'admin-position',employeeId:person,duty:'PRIMARY',
    validFrom:new Date(Date.now()-60000).toISOString(),validTo:null,enabled:true});
  config.appointments.push(appointment('employee-2'),appointment(admin.id));
  const input={id:randomUUID(),expectedVersion:current.version,config,...basis};
  assert.equal((await structure.propose(admin,input,true)).status,'APPROVED');
  assert.equal((await pool.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2',['employee-2',group])).rowCount,1);
  assert.equal((await structure.appointments(admin)).canApply,true);
  assert.ok((await structure.appointments(admin)).people.some(p=>p.id===admin.id));
  assert.equal((await structure.appointments(admin)).items.find(a=>a.employeeId===admin.id).validTo,null);
  await fails(support.propose(admin,{id:randomUUID(),kind:'MEMBER_REMOVE',groupId:group,employeeId:admin.id,
    expectedGroupVersion:await groupVersion(),config:{},...basis},true),'SUPPORT_POSITION_APPOINTMENT_ACTIVE');
  const structureSaved=await snapshot();
  await structure.propose(admin,input,true);assert.equal(await snapshot(),structureSaved);
  await assert.rejects(structure.propose(employee,{...input,id:randomUUID()},true));
  await fails(structure.propose(admin,{...input,id:randomUUID(),direct:true},true),'INVALID_SERVICE_STRUCTURE');
  await fails(structure.propose(admin,{...input,id:randomUUID()},true),'SERVICE_STRUCTURE_VERSION_CONFLICT');
  assert.equal(await snapshot(),structureSaved,'failed direct configuration leaves no audit or membership');

  // Publish a catalog and its routing in one transaction; two configured people become candidates.
  current=await structure.list(admin);config=structuredClone(current.config);
  config.mappings.push({serviceCode:'INC-ADMINTEST',domainId:'admin-domain',systemId:'admin-system',
    primaryPositionId:'admin-position',collaboratingPositionIds:[],enabled:true});
  const catalogChange={expectedVersion:0,code:'INC-ADMINTEST',type:'INC',name:'Custom service',description:'Admin managed service',
    published:true,groupId:group,visibleGroups:[],sortOrder:50,fields:[],approval:null,maxValidityDays:null,initialPublisherId:null};
  const bundle={id:randomUUID(),expectedVersion:current.version,config,catalogChange,...basis};
  const preview=await structure.preview(admin,bundle);
  assert.deepEqual(preview.items.find(x=>x.serviceCode===catalogChange.code).candidates.map(p=>p.id).sort(),[admin.id,'employee-2'].sort());
  await structure.propose(admin,bundle,true);
  assert.equal((await pool.query('SELECT published FROM service_catalog WHERE code=$1',[catalogChange.code])).rows[0].published,true);
  current=await structure.list(admin);
  const beforeFailure=await snapshot();
  const uncovered=structuredClone(current.config);
  uncovered.appointments.forEach(a=>{a.enabled=false;});
  await fails(structure.propose(admin,{id:randomUUID(),expectedVersion:current.version,config:uncovered,...basis},true),'SERVICE_STRUCTURE_COVERAGE_REQUIRED');
  assert.equal(await snapshot(),beforeFailure,'no-coverage publish rolls back proposal and all audit');
  const invalid=structuredClone(current.config);invalid.appointments.push(appointment('inactive-test'));
  await pool.query("INSERT INTO employees(id,display_name,active) VALUES('inactive-test','Inactive fixture',false)");
  await fails(structure.propose(admin,{id:randomUUID(),expectedVersion:current.version,config:invalid,...basis},true),'SERVICE_STRUCTURE_PERSON_UNAVAILABLE');
  assert.equal(await snapshot(),beforeFailure);
  await pool.query("INSERT INTO employees(id,display_name) VALUES('unlinked-test','Unlinked fixture')");
  const unlinked=structuredClone(current.config);unlinked.appointments.push(appointment('unlinked-test'));
  process.env.NOTIFICATION_MODE='dingtalk';
  await fails(structure.propose(admin,{id:randomUUID(),expectedVersion:current.version,config:unlinked,...basis},true),'SERVICE_STRUCTURE_DING_ID_REQUIRED');
  process.env.NOTIFICATION_MODE='disabled';
  assert.equal(await snapshot(),beforeFailure);
  const catalog=await structure.catalog(admin);
  assert.ok(catalog.items.filter(x=>x.type==='REQ').every(x=>x.canPropose),'platform admins can maintain REQ catalog');
  assert.ok(catalog.items.filter(x=>x.type==='GEN').every(x=>!x.canPropose),'GEN remains reserved fallback');
  const reqConfig=structuredClone(current.config);
  reqConfig.mappings.push({serviceCode:'REQ-ADMINTEST',domainId:'admin-domain',systemId:'admin-system',primaryPositionId:'admin-position',collaboratingPositionIds:[],enabled:true});
  const req={...catalogChange,code:'REQ-ADMINTEST',type:'REQ',initialPublisherId:admin.id,maxValidityDays:30,
    approval:{templateId:'DISPOSABLE',steps:[{role:'MANAGER'}]}};
  await structure.propose(admin,{id:randomUUID(),expectedVersion:current.version,config:reqConfig,catalogChange:req,...basis},true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM request_catalog_publishers WHERE service_code=$1',[req.code])).rows[0].n,1);
  const revoked=await roles.decide(admin,binding.id,{expectedVersion:binding.version,...basis},true);
  assert.equal(revoked.effective,false);
  assert.equal((await pool.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2',[employee.id,group])).rowCount,1,
    'revoking a role preserves separately managed membership');
  assert.deepEqual((await roles.history(admin,binding.id)).items.map(x=>x.action),['APPROVED','REVOKED']);
  console.log('PASS admin direct configuration: roles, self assignment, members, positions, catalog, routing, legacy review, replay and rollback');
}finally{
  await pool?.end();
  await control.query(`DROP DATABASE IF EXISTS ${name}`);
  await control.end();
}
