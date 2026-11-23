import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1',path='/admin/service-structure';
async function request(url,user='demo-admin-1',body){
  const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':randomUUID()},
    body:body===undefined?undefined:JSON.stringify({contentClass:'GENERAL',...body})});
  return {status:response.status,data:await response.json()};
}
async function sql(query,success=true){
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml',
      'exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.once('error',reject);
    child.once('close',code=>success?(code===0?resolve(output.trim()):reject(new Error('CATALOG_FIXTURE_SQL_FAILED'))):resolve(code));
  });
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const ok=async promise=>{const result=await promise;assert.ok([200,201].includes(result.status),JSON.stringify(result));return result.data;};
const current=()=>ok(request(path));
const review=(item,user='demo-admin-2',decision='APPROVE')=>request(`${path}/${item.id}/review`,user,{expectedVersion:item.version,decision,reason:'Independent catalog and routing review'});
async function body(config,catalogChange){return {id:randomUUID(),expectedVersion:(await current()).version,config,catalogChange,reason:'CI catalog and routing bundle'};}
async function publish(config,change){const item=await ok(request(path,'demo-admin-1',await body(config,change)));await ok(review(item));return item;}
const suffix=randomUUID().replaceAll('-','').slice(0,10).toUpperCase(),code=`INC-LAB-${suffix}`,reqCode=`REQ-LAB-${suffix}`;
const domain=`domain-${suffix}`,system=`system-${suffix}`,position=`position-${suffix}`,appointment=randomUUID();
const initial=await current(),config=structuredClone(initial.config);
config.domains.push({id:domain,name:'独立试验服务域',enabled:true});
config.systems.push({id:system,name:'自定义设备平台',domainId:domain,enabled:true});
config.positions.push({id:position,name:'试验平台运维',domainId:domain,groupId:'service-desk',enabled:true});
config.appointments.push({id:appointment,positionId:position,employeeId:'agent-1',duty:'PRIMARY',
  validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),enabled:true});
config.mappings.push({serviceCode:code,domainId:domain,systemId:system,primaryPositionId:position,collaboratingPositionIds:[],enabled:true});
const change={expectedVersion:0,code,type:'INC',name:'试验平台故障',description:'独立实验设备故障处理',published:true,
  groupId:'service-desk',visibleGroups:[],sortOrder:5,fields:[{key:'device',label:'设备编号',required:true}],approval:null,maxValidityDays:null,initialPublisherId:null};
assert.equal((await request(`${path}/catalog`,'employee-1')).status,404);
const input=await body(config,change);
assert.equal((await request(path,'employee-1',input)).status,404);
assert.equal((await request(`${path}/preview`,'demo-admin-1',{...input,catalogChange:{...change,groupId:'applications'}})).data.code,'CATALOG_ROUTING_BUNDLE_REQUIRED');
assert.equal((await ok(request(`${path}/preview`,'demo-admin-1',input))).items.find(r=>r.serviceCode===code).candidates[0].id,'agent-1');
let proposal=await ok(request(path,'demo-admin-1',input));
assert.equal(await sql(`SELECT count(*) FROM service_catalog WHERE code=${quote(code)}`),'0','pending proposals do not publish catalog');
assert.equal((await current()).version,initial.version);
assert.equal((await ok(request(path,'demo-admin-1',input))).id,proposal.id);
assert.equal((await review(proposal,'demo-admin-1')).status,403);
await ok(review(proposal));await ok(review(proposal));
assert.equal((await current()).version,initial.version+1);
assert.equal((await ok(request(`${path}/catalog`))).items.find(i=>i.code===code).formVersion,1);
assert.equal(await sql(`SELECT count(*) FROM service_catalog_revisions WHERE service_code=${quote(code)}`),'1');
assert.notEqual(await sql(`DELETE FROM service_catalog_revisions WHERE service_code=${quote(code)}`,false),0);
assert.notEqual(await sql(`UPDATE service_catalog_revisions SET snapshot='{}' WHERE service_code=${quote(code)}`,false),0);

const create=(version=1,fields={device:'LAB-01'})=>request('/tickets','employee-1',{serviceCode:code,formVersion:version,subject:'Experimental device unavailable',
  description:'Device cannot finish routine operations',impact:'INDIVIDUAL',urgency:'LOW',fields});
assert.equal((await create(1,{})).data.code,'REQUIRED_FIELDS_MISSING');
const ticket=await ok(create());
const owned=await ok(request(`/tickets/${ticket.id}/actions`,'agent-1',{action:'ACCEPT',expectedVersion:ticket.version,comment:'Appointed engineer accepts'}));
const snapshot=await sql(`SELECT service_routing_snapshot::text FROM tickets WHERE id=${quote(ticket.id)}`);
const sla=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`);
assert.equal(JSON.parse(snapshot).primaryPositionId,position);

const noCoverage=structuredClone((await current()).config);noCoverage.appointments.find(a=>a.id===appointment).enabled=false;
proposal=await ok(request(path,'demo-admin-1',await body(noCoverage,{...change,expectedVersion:1,name:'不应部分发布'})));
assert.equal((await review(proposal)).data.code,'SERVICE_STRUCTURE_COVERAGE_REQUIRED');
assert.equal(await sql(`SELECT name FROM service_catalog WHERE code=${quote(code)}`),change.name);
await ok(review(proposal,'demo-admin-2','REJECT'));

const edited={...change,expectedVersion:1,name:'试验平台支持',sortOrder:2,fields:[...change.fields,{key:'module',label:'模块',required:false}]};
const live=(await current()).config,stale=await ok(request(path,'demo-admin-1',await body(live,edited)));
await publish(live,edited);
assert.equal((await review(stale)).status,409);await ok(review(stale,'demo-admin-2','REJECT'));
assert.equal((await create()).data.code,'FORM_VERSION_CONFLICT');await ok(create(2));
assert.equal((await ok(request(`/tickets/${ticket.id}`,'agent-1'))).assigneeId,owned.assigneeId);
assert.equal(await sql(`SELECT service_routing_snapshot::text FROM tickets WHERE id=${quote(ticket.id)}`),snapshot);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`),sla);

let next=structuredClone((await current()).config);next.mappings.find(m=>m.serviceCode===code).enabled=false;
await publish(next,{...edited,expectedVersion:2,published:false});
assert.equal((await create(3)).data.code,'SERVICE_UNAVAILABLE');
next=structuredClone((await current()).config);next.mappings.find(m=>m.serviceCode===code).enabled=true;
await publish(next,{...edited,expectedVersion:3,published:true,visibleGroups:['applications']});
assert.equal((await create(4)).data.code,'SERVICE_UNAVAILABLE','visibility remains enforced server-side');
await publish((await current()).config,{...edited,expectedVersion:4,published:true});await ok(create(5));

const req={...change,code:reqCode,type:'REQ',name:'实验资源申请',approval:{templateId:'CI-LAB-OA',steps:[{role:'MANAGER'}]},
  maxValidityDays:30,initialPublisherId:'demo-admin-1'};
next=structuredClone((await current()).config);next.mappings.push({...next.mappings.find(m=>m.serviceCode===code),serviceCode:reqCode});
const wasMember=await sql("SELECT count(*) FROM group_memberships WHERE employee_id='demo-admin-1' AND group_id='service-desk'");
// Earlier admin configuration scenarios may already have enrolled this fixture.
await sql("DELETE FROM group_memberships WHERE employee_id='demo-admin-1' AND group_id='service-desk'");
assert.equal((await request(path,'demo-admin-1',await body(next,req))).data.code,'CATALOG_INITIAL_PUBLISHER_REQUIRED');
await sql("INSERT INTO group_memberships(employee_id,group_id) VALUES('demo-admin-1','service-desk') ON CONFLICT DO NOTHING");
await publish(next,req);
assert.equal(await sql(`SELECT count(*) FROM request_catalog_publishers WHERE service_code=${quote(reqCode)} AND employee_id='demo-admin-1'`),'1');
assert.equal(await sql(`SELECT snapshot->'approval'->>'templateId' FROM request_catalog_versions WHERE service_code=${quote(reqCode)} AND form_version=1`),'CI-LAB-OA');
const reqChange={...req,expectedVersion:1,initialPublisherId:null};
assert.equal((await request(path,'demo-admin-2',await body((await current()).config,reqChange))).data.code,'CATALOG_PUBLISHER_REQUIRED');
const count=await sql(`SELECT count(*) FROM tickets WHERE service_code=${quote(reqCode)}`);
assert.equal((await request('/tickets','employee-1',{serviceCode:reqCode,formVersion:1,subject:'Resource access needed',description:'Need laboratory allocation',
  impact:'INDIVIDUAL',urgency:'LOW',fields:{device:'LAB-01'}})).data.code,'REQUEST_APPROVAL_POLICY_NOT_CONFIGURED');
assert.equal(await sql(`SELECT count(*) FROM tickets WHERE service_code=${quote(reqCode)}`),count,'no OA bypass or partial ticket');
proposal=await ok(request(path,'demo-admin-1',await body((await current()).config,reqChange)));
await sql(`DELETE FROM request_catalog_publishers WHERE service_code=${quote(reqCode)} AND employee_id='demo-admin-1'`);
assert.equal((await review(proposal)).data.code,'CATALOG_PUBLISHER_REQUIRED');await ok(review(proposal,'demo-admin-2','REJECT'));
await sql(`INSERT INTO request_catalog_publishers(employee_id,service_code) VALUES('demo-admin-1',${quote(reqCode)})`);
assert.equal((await request(`/request-catalog/${reqCode}/versions`,'demo-admin-1',{expectedVersion:1,name:req.name,description:req.description,
  groupId:'applications',visibleGroups:[],fields:req.fields,approval:req.approval,maxValidityDays:30})).data.code,'SERVICE_STRUCTURE_GROUP_MISMATCH');
proposal=await ok(request(path,'demo-admin-1',await body((await current()).config,reqChange)));
await ok(request(`/request-catalog/${reqCode}/unpublish`,'demo-admin-1',{expectedVersion:1,reason:'Withdraw while bundle is pending'}));
assert.equal((await review(proposal)).data.code,'FORM_VERSION_CONFLICT','legacy withdrawal invalidates pending bundle even when form version is unchanged');
await ok(review(proposal,'demo-admin-2','REJECT'));

next=structuredClone((await current()).config);next.mappings.find(m=>m.serviceCode===reqCode).enabled=false;
await publish(next,{...reqChange,published:false});
next=structuredClone((await current()).config);next.mappings.find(m=>m.serviceCode===code).enabled=false;
await publish(next,{...edited,expectedVersion:5,published:false});
next=structuredClone((await current()).config);
next.domains.find(d=>d.id===domain).enabled=false;next.systems.find(s=>s.id===system).enabled=false;
next.positions.find(p=>p.id===position).enabled=false;next.appointments.find(a=>a.id===appointment).enabled=false;
const retire={id:randomUUID(),expectedVersion:(await current()).version,config:next,reason:'Retire isolated laboratory fixture'};
await ok(review(await ok(request(path,'demo-admin-1',retire))));
if(wasMember==='0')await sql("DELETE FROM group_memberships WHERE employee_id='demo-admin-1' AND group_id='service-desk'");
assert.equal(await sql(`SELECT service_routing_snapshot::text FROM tickets WHERE id=${quote(ticket.id)}`),snapshot);
console.log('Catalog bundles verified: new arbitrary domain/system/position/service, atomic independent review, versions, fields, visibility, disable/restore, historical ownership, publisher revocation and fail-closed OA');
