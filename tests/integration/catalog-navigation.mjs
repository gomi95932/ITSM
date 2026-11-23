import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {CatalogNavigationService} from '../../apps/api/dist/catalog-navigation.service.js';
import {WorkspaceController} from '../../apps/api/dist/workspace.controller.js';
if(process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')throw new Error('DISPOSABLE_DATABASE_REQUIRED');
const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const control=new pg.Client({...connection,database:process.env.DB_NAME});
const name=`itsm_nav_${randomUUID().replaceAll('-','')}`;
const actor=id=>({id,name:id,groups:[]});
const admin=actor('demo-admin-1'),employee=actor('employee-1');
const basis={reason:'Catalog navigation isolation test',contentClass:'GENERAL'};
let pool;
await control.connect();
try{
  await control.query(`CREATE DATABASE ${name}`);
  const migrated=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DB_NAME:name},encoding:'utf8'});
  assert.equal(migrated.status,0,migrated.stderr);
  pool=new pg.Pool({...connection,database:name});
  const db={pool,transaction:async fn=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}};
  const navigation=new CatalogNavigationService(db,{requireGeneral:async()=>{}});
  const snapshot=async()=>JSON.stringify((await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY code) FROM service_catalog c) AS catalog,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY service_code,form_version) FROM request_catalog_versions v) AS forms,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY version) FROM service_structure_versions s) AS routing`)).rows);
  await assert.rejects(navigation.list(employee));
  const initial=await navigation.list(admin),before=await snapshot();
  assert.equal(initial.version,1);assert.ok(initial.items.length>5);
  const items=initial.items.map(item=>item.serviceCode==='INC-BIZ'?{...item,path:['信息化系统','业务系统支持']}:item);
  await assert.rejects(navigation.save(employee,{...basis,expectedVersion:1,items}));
  assert.equal((await navigation.save(admin,{...basis,expectedVersion:1,items})).version,2);
  assert.equal(await snapshot(),before,'navigation changes must not modify catalog, form versions or routing');
  await assert.rejects(navigation.save(admin,{...basis,expectedVersion:1,items}),e=>e.getResponse().code==='CATALOG_NAVIGATION_VERSION_CONFLICT');
  await assert.rejects(navigation.save(admin,{...basis,expectedVersion:2,items:items.slice(1)}),e=>e.getResponse().code==='CATALOG_NAVIGATION_SERVICES_CHANGED');
  const concurrent=await Promise.allSettled([1,2].map(()=>navigation.save(admin,{...basis,expectedVersion:2,items})));
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await navigation.list(admin)).version,3);
  assert.equal(await snapshot(),before);
  await assert.rejects(pool.query("UPDATE catalog_navigation_versions SET reason='tampered' WHERE version=2"));
  await assert.rejects(pool.query('DELETE FROM catalog_navigation_versions WHERE version=2'));
  const versions=(await navigation.list(admin)).history;
  assert.equal(versions.find(v=>v.version===2).actorName,'演示配置管理员一');
  const workspace=new WorkspaceController(db,{identity:async()=>employee},{},{},{});
  let catalog=(await workspace.catalog({})).items;
  const biz=catalog.find(item=>item.code==='INC-BIZ');
  assert.deepEqual(biz.navigationPath,['信息化系统','业务系统支持']);assert.equal(biz.formVersion,1);
  const available=new Map(catalog.map(item=>[item.code,item.available]));
  assert.equal(available.get('INC-PC'),true);assert.equal(available.get('REQ-ACCOUNT'),false);
  await pool.query("UPDATE service_catalog SET visible_groups='[\"applications\"]' WHERE code='INC-BIZ'");
  catalog=(await workspace.catalog({})).items;
  assert.equal(catalog.some(item=>item.code==='INC-BIZ'),false,'hidden service metadata must not reach employees');
  await pool.query("UPDATE service_catalog SET published=false WHERE code='INC-NET'");
  assert.equal((await workspace.catalog({})).items.some(item=>item.code==='INC-NET'),false);
  const adminWorkspace=new WorkspaceController(db,{identity:async()=>admin},{},{},{});
  let all=(await adminWorkspace.catalog({})).items;
  assert.equal(all.length,Number((await pool.query('SELECT count(*) FROM service_catalog')).rows[0].count));
  assert.equal(all.find(item=>item.code==='INC-BIZ').unavailableReason,'OUT_OF_SCOPE');
  assert.equal(all.find(item=>item.code==='INC-BIZ').available,false);
  assert.equal(all.find(item=>item.code==='INC-NET').unavailableReason,'UNPUBLISHED');
  assert.equal(all.find(item=>item.code==='INC-NET').published,false);
  assert.equal(all.find(item=>item.code==='INC-NET').available,false);
  assert.equal(all.find(item=>item.code==='REQ-ACCOUNT').unavailableReason,'NOT_READY');
  assert.equal(all.find(item=>item.code==='INC-PC').available,true);
  const spoofed=new WorkspaceController(db,{identity:async()=>({...employee,canManageRouting:true})},{},{},{});
  assert.equal((await spoofed.catalog({})).items.some(item=>item.code==='INC-BIZ'),false,'database roles govern full visibility');
  await pool.query(`INSERT INTO operations_versions(version,config) VALUES(2,
    '{"siteEnforced":true,"sites":[],"employeeSites":[],"serviceSites":[]}')`);
  assert.equal((await workspace.catalog({})).items.length,0);
  all=(await adminWorkspace.catalog({})).items;
  assert.equal(all.find(item=>item.code==='INC-PC').unavailableReason,'OUT_OF_SCOPE','admin can inspect services outside their site');
  assert.equal(all.find(item=>item.code==='INC-PC').available,false);
  await pool.query(`INSERT INTO operations_versions(version,config) SELECT 3,config FROM operations_versions WHERE version=1`);
  await pool.query(`UPDATE role_bindings SET status='REVOKED' WHERE employee_id=$1 AND role_code='PLATFORM_ADMIN'`,[admin.id]);
  assert.equal((await adminWorkspace.catalog({})).items.some(item=>item.code==='INC-BIZ'),false,'revocation takes effect without a new session');
  await pool.query(`UPDATE role_bindings SET status='ACTIVE',valid_from=now()-interval '2 days',valid_to=now()-interval '1 day'
    WHERE employee_id=$1 AND role_code='PLATFORM_ADMIN'`,[admin.id]);
  assert.equal((await adminWorkspace.catalog({})).items.some(item=>item.code==='INC-NET'),false,'expired administrators have no bypass');
  await pool.query(`UPDATE role_bindings SET valid_to=now()+interval '1 day' WHERE employee_id=$1 AND role_code='PLATFORM_ADMIN'`,[admin.id]);
  const dispatcher=new WorkspaceController(db,{identity:async()=>actor('agent-1')},{},{},{});
  assert.equal((await dispatcher.catalog({})).items.some(item=>item.code==='INC-NET'),false,'dispatcher is not a platform administrator');
  await pool.query(`INSERT INTO service_catalog(code,type,form_version,group_id,name,description,required_fields,field_schema,published,visible_groups,sort_order)
    SELECT code,type,form_version,group_id,name,description,required_fields,field_schema,published,visible_groups,140
    FROM (SELECT unnest(ARRAY['INC-SRM','INC-CUSTOMAPP']) AS code) codes CROSS JOIN LATERAL
      (SELECT type,form_version,group_id,name,description,required_fields,field_schema,published,visible_groups FROM service_catalog WHERE code='INC-PC') template`);
  assert.deepEqual((await navigation.list(admin)).items.find(item=>item.serviceCode==='INC-SRM').path,['信息化系统','SRM系统']);
  assert.deepEqual((await adminWorkspace.catalog({})).items.find(item=>item.code==='INC-SRM').navigationPath,['信息化系统','SRM系统']);
  const structure={domains:[{id:'nav-domain',name:'Infrastructure',enabled:true}],
    systems:[{id:'nav-crm',name:'CRM',domainId:'nav-domain',enabled:true}],
    positions:[{id:'nav-position',name:'Helpdesk',domainId:'nav-domain',groupId:'service-desk',enabled:true}],
    appointments:[{id:randomUUID(),positionId:'nav-position',employeeId:'agent-1',duty:'PRIMARY',
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:null,enabled:true}],
    mappings:['INC-PC','INC-CUSTOMAPP'].map(serviceCode=>({serviceCode,domainId:'nav-domain',
      ...(serviceCode==='INC-CUSTOMAPP'?{systemId:'nav-crm'}:{}),
      primaryPositionId:'nav-position',collaboratingPositionIds:[],enabled:true}))};
  await pool.query('INSERT INTO service_structure_versions(version,config) VALUES(2,$1)',[JSON.stringify(structure)]);
  await pool.query('UPDATE service_structure_current SET version=2');
  let readiness=(await navigation.list(admin)).services.find(row=>row.code==='INC-PC');
  assert.equal(readiness.mapped,true);assert.equal(readiness.staffed,true,'permanent active appointments count as staffed');
  assert.deepEqual((await navigation.list(admin)).items.find(item=>item.serviceCode==='INC-CUSTOMAPP').path,['信息化系统','CRM系统']);
  assert.deepEqual((await adminWorkspace.catalog({})).items.find(item=>item.code==='INC-CUSTOMAPP').navigationPath,['信息化系统','CRM系统']);
  const custom=(await navigation.list(admin)).items.map(item=>item.serviceCode==='INC-CUSTOMAPP'?{...item,path:['自定义业务','客户支持']}:item);
  await navigation.save(admin,{...basis,expectedVersion:3,items:custom});
  assert.deepEqual((await adminWorkspace.catalog({})).items.find(item=>item.code==='INC-CUSTOMAPP').navigationPath,['自定义业务','客户支持'],
    'explicit administrator categories take precedence over defaults');
  await pool.query("UPDATE employees SET active=false WHERE id='agent-1'");
  readiness=(await navigation.list(admin)).services.find(row=>row.code==='INC-PC');
  assert.equal(readiness.mapped,true);assert.equal(readiness.staffed,false,'inactive personnel must not appear ready');
  await pool.query("UPDATE employees SET active=true WHERE id='agent-1'");
  await pool.query("UPDATE employees SET active=false WHERE id='demo-admin-1'");
  assert.equal((await adminWorkspace.catalog({})).items.some(item=>item.code==='INC-NET'),false,'inactive accounts cannot obtain full visibility');
  await assert.rejects(navigation.save(admin,{...basis,expectedVersion:3,items}));
  console.log('Catalog navigation integration passed: authorization, immutable audit, concurrent saves, visibility, availability, staffing and business invariance');
}finally{if(pool)await pool.end();await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await control.end();}
