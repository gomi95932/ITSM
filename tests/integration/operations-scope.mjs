import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

// This final CI phase deliberately enables irreversible isolation in a disposable database.
if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1',structure='/admin/service-structure',operations='/admin/operations';
async function request(path,user='demo-admin-1',body,key=randomUUID()){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},
    body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
const ok=async promise=>{const r=await promise;assert.ok([200,201].includes(r.status),JSON.stringify(r));return r.data;};
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
async function sql(query,success=true){return new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml',
    'exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
  let out='',error='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>error+=v);child.once('error',reject);
  child.once('close',code=>success?(code===0?resolve(out.trim()):reject(new Error(`OPERATIONS_FIXTURE_SQL_FAILED: ${error}`))):resolve(code));
});}
const readStructure=()=>ok(request(structure));
const readOperations=()=>ok(request(operations));
async function publishStructure(config){const current=await readStructure();
  const p=await ok(request(structure,'demo-admin-1',{id:randomUUID(),expectedVersion:current.version,config,reason:'CI operations fixture'}));
  await ok(request(`${structure}/${p.id}/review`,'demo-admin-2',{expectedVersion:p.version,decision:'APPROVE',reason:'Independent CI review'}));
}
async function proposeOperations(config){const {current}=await readOperations();return ok(request(operations,'demo-admin-1',{
  id:randomUUID(),expectedVersion:current.version,config,reason:'CI reviewed site and service SLA configuration'}));}
async function publishOperations(config){const p=await proposeOperations(config);
  const body={expectedVersion:p.version,decision:'APPROVE',reason:'Independent CI operations review'};
  assert.equal((await request(`${operations}/${p.id}/review`,'demo-admin-1',body)).status,403);
  const result=await ok(request(`${operations}/${p.id}/review`,'demo-admin-2',body));
  assert.deepEqual(await ok(request(`${operations}/${p.id}/review`,'demo-admin-2',body)),result,'review retry is idempotent');
  return (await readOperations()).current;
}
const person={requesterA:'ops-requester-a',requesterB:'ops-requester-b',engineerA:'ops-engineer-a',engineerB:'ops-engineer-b',
  backup:'ops-backup-a',lead:'ops-lead',cross:'ops-cross',unknown:'ops-no-site'};
const siteA='ops-site-a',siteB='ops-site-b',domain='ops-domain',posA='ops-position-a',posB='ops-position-b',posCross='ops-position-cross';
await sql(`INSERT INTO employees(id,display_name) VALUES ${Object.values(person).map(id=>`(${quote(id)},${quote(id)})`).join(',')};
  INSERT INTO group_memberships(employee_id,group_id) VALUES ${['engineerA','engineerB','backup','lead','cross'].map(k=>`(${quote(person[k])},'service-desk')`).join(',')};
  INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,source,requested_by,reviewed_by,reason,reviewed_at)
    VALUES(${quote(randomUUID())},${quote(person.lead)},'GROUP_LEAD','service-desk',now()-interval '1 day',now()+interval '1 day',
      'ACTIVE','REVIEW','demo-admin-1','demo-admin-2','Disposable operations lead',now());
  UPDATE service_catalog SET published=false WHERE group_id IN (SELECT id FROM support_groups WHERE NOT enabled);
  UPDATE service_catalog SET published=true,group_id='service-desk',required_fields='[]',field_schema='[]',visible_groups='[]' WHERE code='INC-PC';`);
const config=structuredClone((await readStructure()).config);
// Retain every historical identifier, retiring prior test routes before this isolated final phase.
config.positions.forEach(p=>p.enabled=false);config.appointments.forEach(a=>a.enabled=false);config.mappings.forEach(m=>m.enabled=false);
config.domains.push({id:domain,name:'Operations CI',enabled:true});
for(const id of [posA,posB,posCross])config.positions.push({id,name:id,domainId:domain,groupId:'service-desk',enabled:true});
const appointment=(employeeId,positionId,duty='PRIMARY')=>({id:randomUUID(),employeeId,positionId,duty,
  validFrom:new Date(Date.now()-86400000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),enabled:true});
const primary=appointment(person.engineerA,posA),backup=appointment(person.backup,posA,'BACKUP');
config.appointments.push(primary,backup,appointment(person.engineerB,posB),appointment(person.cross,posCross));
const mapping={serviceCode:'INC-PC',domainId:domain,systemId:null,primaryPositionId:posA,collaboratingPositionIds:[posB],enabled:true};
const previousMapping=config.mappings.findIndex(m=>m.serviceCode==='INC-PC');
if(previousMapping<0)config.mappings.push(mapping);else config.mappings[previousMapping]=mapping;
const services=JSON.parse(await sql(`SELECT json_agg(json_build_object('code',code,'groupId',group_id)) FROM service_catalog WHERE published`));
const groups=[...new Set(services.map(s=>s.groupId))],routePositions=new Map([['service-desk',posA]]);
for(const [index,group] of groups.entries())if(group!=='service-desk'){
  const id=`ops-position-group-${index}`;routePositions.set(group,id);config.positions.push({id,name:id,domainId:domain,groupId:group,enabled:true});
}
await publishStructure(config);
const action=(t,user,action,extra={},key)=>request(`/tickets/${t.id}/actions`,user,{expectedVersion:t.version,action,...extra},key);
const create=(user=person.requesterA,extra={})=>request('/tickets',user,{serviceCode:'INC-PC',formVersion:1,subject:`Operations ${randomUUID()}`,
  description:'Peripheral device unavailable',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{},...extra});
const legacy=await ok(create());await ok(action(legacy,person.requesterA,'CANCEL'));
await ok(create()); // Explicit in-flight legacy fixture makes the activation guard deterministic.
const targets={P1:{response:10,resolution:120},P2:{response:30,resolution:240},P3:{response:90,resolution:600},P4:{response:180,resolution:1200}};
const ops={siteEnforced:true,sites:[{id:siteA,name:'Site A',enabled:true},{id:siteB,name:'Site B',enabled:true}],
  employeeSites:Object.values(person).filter(id=>id!==person.unknown).map(id=>({employeeId:id,homeSiteId:[person.requesterB,person.engineerB].includes(id)?siteB:siteA,
    siteIds:[person.lead,person.cross].includes(id)?[siteA,siteB]:[[person.requesterB,person.engineerB].includes(id)?siteB:siteA]})),
  groupSites:groups.map(groupId=>({groupId,siteIds:groupId==='service-desk'?[siteA,siteB]:[siteA]})),
  positionSites:[{positionId:posA,siteIds:[siteA]},{positionId:posB,siteIds:[siteB]},{positionId:posCross,siteIds:[siteB]},
    ...[...routePositions].filter(([g])=>g!=='service-desk').map(([,positionId])=>({positionId,siteIds:[siteA]}))],
  serviceSites:services.map(s=>({serviceCode:s.code,siteIds:s.code==='INC-PC'?[siteA,siteB]:[siteA]})),
  siteRoutes:[...services.map(s=>({serviceCode:s.code,siteId:siteA,positionId:routePositions.get(s.groupId)})),{serviceCode:'INC-PC',siteId:siteB,positionId:posB}],
  slaTemplates:[{id:'ops-standard',name:'Operations SLA',enabled:true,targets}],serviceSlas:[{serviceCode:'INC-PC',templateId:'ops-standard'}]};
assert.equal((await request(operations,person.engineerA)).status,403);
let current=(await readOperations()).current;
assert.equal((await request(operations,'demo-admin-1',{id:randomUUID(),expectedVersion:current.version,config:ops,reason:'Unsafe migration'})).data.code,
  'SITE_LEGACY_TICKETS_REQUIRE_CLOSURE');
// Prior test data is explicitly pre-migrated only in this disposable fixture. Production has no bypass.
await sql(`UPDATE tickets SET service_routing_snapshot=service_routing_snapshot||${quote(JSON.stringify({site:{id:siteA,name:'CI prior fixture',configVersion:1}}))}::jsonb
  WHERE status NOT IN ('CLOSED','CANCELLED','REJECTED')`);
current=await publishOperations(ops);
assert.notEqual(await sql(`UPDATE operations_versions SET config='{}' WHERE version=${current.version}`,false),0);
assert.equal((await request(operations,'demo-admin-1',{id:randomUUID(),expectedVersion:current.version,config:{...ops,siteEnforced:false},reason:'Disable isolation'})).data.code,
  'SITE_ISOLATION_CANNOT_BE_DISABLED');
assert.equal((await create(person.unknown)).data.code,'EMPLOYEE_SITE_REQUIRED');
assert.equal((await create(person.requesterA,{siteId:siteB})).status,400,'requester cannot supply a site');
assert.equal((await request(`/tickets/${legacy.id}`,person.requesterA)).status,200);
assert.equal((await request(`/tickets/${legacy.id}`,person.engineerA)).status,404,'unscoped closed history fails closed');
let a=await ok(create()),b=await ok(create(person.requesterB));
let detail=await ok(request(`/tickets/${a.id}`,person.engineerA));
assert.equal(detail.site.id,siteA);assert.equal(detail.site.configVersion,current.version);
assert.equal(detail.sla[0].responseTarget,targets[detail.priority].response);
assert.equal(detail.sla[0].template.id,'ops-standard');
assert.equal((await request(`/tickets/${a.id}`,person.engineerB)).status,404);
assert.equal((await request(`/tickets/${b.id}`,person.engineerA)).status,404);
assert.equal((await request(`/tickets/${a.id}/assignment-candidates?groupId=service-desk`,person.lead)).status,200);
assert.deepEqual((await ok(request(`/tickets/${a.id}/assignment-candidates?groupId=service-desk`,person.lead))).items.map(p=>p.id).sort(),[person.backup,person.engineerA].sort());
assert.ok(!(await ok(request('/tickets?mine=false&size=100',person.engineerB))).items.some(t=>t.id===a.id));
assert.equal(await sql(`SELECT service_position_eligible(${quote(JSON.stringify({site:{id:siteA},positions:[{id:posA,groupId:'service-desk'},{id:posCross,groupId:'service-desk'}]}))},${quote(person.cross)},'service-desk')`),'f',
  'the appointed position itself must cover the site, not another position');
const originalCycle=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(a.id)}`);
const changed=structuredClone(ops);changed.slaTemplates[0].targets.P3.response=80;
await publishOperations(changed);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(a.id)}`),originalCycle);
const next=await ok(create());const nextDetail=await ok(request(`/tickets/${next.id}`,person.requesterA));
assert.equal(nextDetail.sla[0].responseTarget,changed.slaTemplates[0].targets[nextDetail.priority].response);
assert.notEqual(await sql(`UPDATE sla_cycles SET template_snapshot='{}' WHERE ticket_id=${quote(a.id)}`,false),0);
assert.equal((await action(a,person.engineerA,'FORCE_TAKEOVER',{targetGroupId:'service-desk',targetAssigneeId:person.backup,reason:'No lead role'})).status,403);
const takeover={targetGroupId:'service-desk',targetAssigneeId:person.engineerA,reason:'Supervisor assigns current on-call engineer'};
const takeoverKey=randomUUID(),original=a;
a=await ok(action(a,person.lead,'FORCE_TAKEOVER',takeover,takeoverKey));
assert.equal(a.assigneeId,person.engineerA);assert.equal(a.status,'IN_PROGRESS');
assert.deepEqual(await ok(action(original,person.lead,'FORCE_TAKEOVER',takeover,takeoverKey)),a);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(a.id)}`),originalCycle,'takeover is neither response nor SLA restart');
a=await ok(action(a,person.engineerA,'REQUEST_INFO',{comment:'Please provide device label',waitingReason:'USER_INFORMATION',dueAt:new Date(Date.now()+3600000).toISOString()}));
const waitingCycle=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(a.id)}`);
const appointments=await ok(request(`${structure}/appointments`,person.lead));
assert.ok(appointments.positions.every(p=>p.groupId==='service-desk'));
assert.equal((await request(`${structure}/appointments`,person.engineerA)).status,404);
assert.equal((await request(`${structure}/appointments`,person.lead,{id:randomUUID(),expectedVersion:appointments.version,
  appointment:appointment(person.lead,posA),reason:'Self appointment'})).data.code,'SELF_APPOINTMENT_NOT_ALLOWED');
const overscope=structuredClone((await readStructure()).config);overscope.domains.at(-1).name='Unapproved structural change';
assert.equal((await request(structure,person.lead,{id:randomUUID(),expectedVersion:appointments.version,config:overscope,reason:'Over scope'})).data.code,'APPOINTMENT_SCOPE_REQUIRED');
const proposed=await ok(request(`${structure}/appointments`,person.lead,{id:randomUUID(),expectedVersion:appointments.version,
  appointment:{...backup,duty:'PRIMARY'},reason:'Reviewed backup responsibility update'}));
await ok(request(`${structure}/${proposed.id}/review`,'demo-admin-1',{expectedVersion:proposed.version,decision:'APPROVE',reason:'Independent appointment review'}));
const revocation={id:randomUUID(),expectedVersion:(await readStructure()).version,appointmentId:primary.id,reason:'Emergency rotation ends current appointment'};
const revoked=await ok(request(`${structure}/appointments/revoke`,person.lead,revocation));
assert.deepEqual(await ok(request(`${structure}/appointments/revoke`,person.lead,revocation)),revoked);
assert.equal((await ok(request(`/tickets/${a.id}`,person.engineerA))).canProcess,false);
assert.equal((await action(a,person.engineerA,'RESOLVE',{comment:'Old appointment',resolutionCategory:'FIX',evidence:'Device checked'})).status,403);
assert.notEqual(await sql(`DELETE FROM appointment_emergency_revocations WHERE id=${quote(revocation.id)}`,false),0);
const race=await Promise.all([1,2].map(()=>action(a,person.lead,'FORCE_TAKEOVER',{targetGroupId:'service-desk',targetAssigneeId:person.backup,reason:'Emergency backup assumes responsibility'})));
assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);a=race.find(r=>r.status===200).data;
assert.equal(a.status,'WAITING_USER');assert.equal(a.assigneeId,person.backup);assert.equal(a.pendingAssigneeId,null);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(a.id)}`),waitingCycle,'waiting and SLA pause survive takeover');
assert.equal(await sql(`SELECT count(*) FROM audit_logs WHERE ticket_id=${quote(a.id)} AND action='FORCE_TAKEOVER'
  AND before_value->>'assigneeId'=${quote(person.engineerA)} AND after_value->>'assigneeId'=${quote(person.backup)}`),'1');
a=await ok(action(a,person.requesterA,'ADD_INFO',{comment:'Device label provided'}));
a=await ok(action(a,person.backup,'RESOLVE',{comment:'Cable replaced and device verified',resolutionCategory:'FIX',evidence:'Requester witnessed normal operation'}));
a=await ok(action(a,person.requesterA,'CONFIRM'));assert.equal(a.status,'CLOSED');
assert.equal((await ok(request(`/tickets/${a.id}`,person.requesterA))).status,'CLOSED');
console.log('Operations scope verified: trusted site, cross-site isolation, legacy activation guard, independent review, immutable SLA, same-position eligibility, scoped appointments, emergency revoke, concurrent takeover and requester closure');
