import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1',path='/admin/service-structure';
async function request(url,user='demo-admin-1',body){
  const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':randomUUID()},
    body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query,success=true){
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml',
      'exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.once('error',reject);
    child.once('close',code=>success?(code===0?resolve(output.trim()):reject(new Error('STRUCTURE_FIXTURE_SQL_FAILED'))):resolve(code));
  });
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const ok=async promise=>{const result=await promise;assert.ok([200,201].includes(result.status),JSON.stringify(result));return result.data;};
const list=()=>ok(request(path));
async function propose(config,expectedVersion){return ok(request(path,'demo-admin-1',{id:randomUUID(),expectedVersion,config,reason:'CI custom service structure'}));}
const review=(item,user='demo-admin-2',decision='APPROVE')=>request(`${path}/${item.id}/review`,user,{expectedVersion:item.version,decision,reason:'Independent structure review'});
async function publish(config){const current=await list(),item=await propose(config,current.version);await ok(review(item));return list();}
async function until(check){for(let i=0;i<80;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('STRUCTURE_RECOVERY_TIMEOUT');}
const action=(ticket,user,action,extra={})=>request(`/tickets/${ticket.id}/actions`,user,{expectedVersion:ticket.version,action,...extra});
async function create(){return ok(request('/tickets','employee-1',{serviceCode:'INC-PC',formVersion:1,subject:`Structure ${randomUUID()}`,
  description:'Peripheral device service unavailable',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}}));}

const original=await list(),suffix=randomUUID(),domain=`domain-${suffix}`,system=`system-${suffix}`,position=`position-${suffix}`;
const config=structuredClone(original.config);
config.domains.push({id:domain,name:'研发实验服务域',enabled:true});
config.systems.push({id:system,name:'自定义试验系统',domainId:domain,enabled:true});
config.positions.push({id:position,name:'实验运维工程师',domainId:domain,groupId:'service-desk',enabled:true});
const appointment={id:randomUUID(),positionId:position,employeeId:'agent-3',duty:'PRIMARY',
  validFrom:new Date(Date.now()-60000).toISOString(),validTo:null,enabled:true};
config.appointments.push(appointment);
config.mappings.push({serviceCode:'INC-PC',domainId:domain,systemId:system,primaryPositionId:position,collaboratingPositionIds:[],enabled:true});
assert.equal((await request(path,'employee-1')).status,404);
assert.equal((await request(`${path}/people?q=agent`,'employee-1')).status,404);
assert.ok((await ok(request(`${path}/people?q=agent`))).items.some(p=>p.id==='agent-3'));
const input={id:randomUUID(),expectedVersion:original.version,config,reason:'CI custom domain configuration'};
assert.equal((await request(path,'employee-1',input)).status,404);
assert.equal((await request(path,'demo-admin-1',{...input,config:{...config,roles:[]}})).status,400);
let preview=await ok(request(`${path}/preview`,'demo-admin-1',input));
assert.deepEqual(preview.items.find(row=>row.serviceCode==='INC-PC').candidates.map(p=>p.id),['agent-3']);
for(const [period,expected] of [
  [{validTo:new Date(Date.now()+3*366*86400000).toISOString()},['agent-3']],
  [{validFrom:new Date(Date.now()+86400000).toISOString(),validTo:null},[]],
  [{validFrom:new Date(Date.now()-2*86400000).toISOString(),validTo:new Date(Date.now()-86400000).toISOString()},[]],
]){
  const candidate=structuredClone(config);Object.assign(candidate.appointments.at(-1),period);
  const result=await ok(request(`${path}/preview`,'demo-admin-1',{...input,id:randomUUID(),config:candidate}));
  assert.deepEqual(result.items.find(row=>row.serviceCode==='INC-PC').candidates.map(p=>p.id),expected);
}
const adjacent=structuredClone(config);
adjacent.appointments.at(-1).validFrom=new Date(Date.now()+86400000).toISOString();
adjacent.appointments.push({...appointment,id:randomUUID(),validTo:adjacent.appointments.at(-1).validFrom});
await ok(request(`${path}/preview`,'demo-admin-1',{...input,id:randomUUID(),config:adjacent}));
let proposal=await ok(request(path,'demo-admin-1',input));
assert.deepEqual((await list()).config,original.config,'pending changes do not alter live routes');
assert.equal((await request(path,'demo-admin-1',input)).data.id,proposal.id);
assert.equal((await request(path,'demo-admin-1',{...input,reason:'Different body'})).status,409);
assert.equal((await review(proposal,'demo-admin-1')).status,403);
await ok(review(proposal));
assert.equal((await list()).version,original.version+1);
assert.equal((await list()).config.appointments.find(a=>a.id===appointment.id).validTo,null);
assert.deepEqual((await ok(request(`${path}/${proposal.id}/history`))).items.map(e=>e.action),['PROPOSED','APPROVED']);
assert.notEqual(await sql(`UPDATE service_structure_versions SET config='{}' WHERE version=${original.version+1}`,false),0);
assert.notEqual(await sql(`DELETE FROM service_structure_audits WHERE proposal_id=${quote(proposal.id)}`,false),0);

// The new system route must be reflected in the published directory before employee intake.
const tree=await ok(request('/admin/catalog-navigation/tree'));
const information=tree.nodes.find(node=>node.kind==='CATEGORY'&&node.parentId===null&&node.name==='信息化系统');
const other=tree.nodes.find(node=>node.kind==='CATEGORY'&&node.parentId===null&&node.name==='其他服务');
const leaf=tree.nodes.find(node=>node.kind==='SERVICE'&&node.serviceCode==='INC-PC');
assert.ok(information&&other&&leaf);
const systemNode={id:`system-${randomUUID()}`,parentId:information.id,kind:'SYSTEM',name:'自定义试验系统',
  enabled:true,sortOrder:900,systemId:system,serviceCode:null};
const nodes=tree.nodes.map(node=>node.id===leaf.id?{...node,parentId:systemNode.id}:node).concat(systemNode);
const assigned=new Set(nodes.map(node=>node.serviceCode));
for(const service of tree.services.filter(service=>!assigned.has(service.code))){
  nodes.push({id:`draft-${randomUUID()}`,parentId:other.id,kind:'SERVICE',name:`待上架 ${service.code}`.slice(0,80),
    enabled:false,sortOrder:900,systemId:null,serviceCode:service.code});
}
const directoryChange={expectedVersion:tree.version,navigationVersion:tree.navigationVersion,
  structureVersion:tree.structureVersion,nodes,reason:'CI align test service directory with the new system route'};
await ok(request('/admin/catalog-navigation/tree/preview','demo-admin-1',directoryChange));
await ok(request('/admin/catalog-navigation/tree','demo-admin-1',directoryChange));

const ticket=await create();
const snapshot=await sql(`SELECT service_routing_snapshot::text FROM tickets WHERE id=${quote(ticket.id)}`);
assert.equal(JSON.parse(snapshot).primaryPositionId,position);
assert.equal((await ok(request(`/tickets/${ticket.id}`,'agent-1'))).canClaim,false);
assert.equal((await action(ticket,'agent-1','ACCEPT',{comment:'Not appointed'})).data.code,'POSITION_APPOINTMENT_REQUIRED');
assert.deepEqual((await ok(request(`/tickets/${ticket.id}/assignment-candidates?groupId=service-desk`,'agent-1'))).items.map(p=>p.id),['agent-3']);
assert.equal((await request(`/tickets/${ticket.id}/assignment-candidates?groupId=service-desk`,'employee-1')).status,404);
const owned=await ok(action(ticket,'agent-3','ACCEPT',{comment:'Appointed engineer receives ticket'}));
const sla=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`);
const pending=await create();
await ok(action(pending,'agent-1','ASSIGN_OFFER',{targetAssigneeId:'agent-3',reason:'Appointed candidate'}));

const changed=structuredClone(config);changed.domains.find(d=>d.id===domain).name='研发实验服务域更名';
changed.appointments.find(a=>a.id===appointment.id).enabled=false;
changed.appointments.push({...appointment,id:randomUUID(),employeeId:'agent-1',duty:'BACKUP'});
const stale=await propose(changed,(await list()).version);
const published=await publish(changed);
assert.equal((await review(stale)).status,409,'stale proposals cannot overwrite a newer version');
await ok(review(stale,'demo-admin-2','REJECT'));
assert.equal(await sql(`SELECT service_routing_snapshot::text FROM tickets WHERE id=${quote(ticket.id)}`),snapshot);
assert.equal((await ok(request(`/tickets/${ticket.id}`,'agent-3'))).assigneeId,owned.assigneeId,'configuration never silently changes current owner');
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`),sla);
await until(async()=>await sql(`SELECT assignment_state FROM tickets WHERE id=${quote(pending.id)}`)==='INVALIDATED');
const following=await create();
assert.equal((await action(following,'agent-3','ACCEPT',{comment:'Former appointment'})).data.code,'POSITION_APPOINTMENT_REQUIRED');
assert.equal((await ok(request(`/tickets/${following.id}`,'agent-1'))).canClaim,true);

const overlap=structuredClone(changed);overlap.appointments.push({...changed.appointments.at(-1),id:randomUUID()});
assert.equal((await request(`${path}/preview`,'demo-admin-1',{...input,id:randomUUID(),expectedVersion:published.version,config:overlap})).data.code,'SERVICE_STRUCTURE_APPOINTMENT_OVERLAP');
const missing=structuredClone(changed);missing.domains=missing.domains.filter(d=>d.id!==domain);
assert.equal((await request(`${path}/preview`,'demo-admin-1',{...input,id:randomUUID(),expectedVersion:published.version,config:missing})).status,400);
const none=structuredClone(changed);none.appointments.forEach(a=>{if(a.positionId===position)a.enabled=false;});
proposal=await propose(none,published.version);
assert.equal((await review(proposal)).data.code,'SERVICE_STRUCTURE_COVERAGE_REQUIRED');
await ok(review(proposal,'demo-admin-2','REJECT'));

// Retire this isolated configuration through the same reviewed path; never erase published ids.
const disabled=structuredClone(changed);
disabled.domains.find(row=>row.id===domain).enabled=false;
disabled.systems.find(row=>row.id===system).enabled=false;
disabled.positions.find(row=>row.id===position).enabled=false;
for(const row of disabled.appointments)if(row.positionId===position)row.enabled=false;
disabled.mappings.find(row=>row.serviceCode==='INC-PC').enabled=false;
await publish(disabled);
assert.equal((await request('/tickets','employee-1',{serviceCode:'INC-PC',formVersion:1,subject:'Disabled service',description:'Disabled route',impact:'INDIVIDUAL',urgency:'LOW',fields:{}})).data.code,'SERVICE_UNAVAILABLE');
await until(async()=>await sql(`SELECT count(*) FROM ticket_routing_alerts WHERE ticket_id=${quote(following.id)} AND reason='NO_POSITION_COVERAGE' AND resolved_at IS NULL`)==='1');
assert.equal(await sql(`SELECT owner_group_id FROM tickets WHERE id=${quote(following.id)}`),'service-desk','no silent fallback outside configured positions');
assert.equal(await sql(`SELECT service_routing_snapshot::text FROM tickets WHERE id=${quote(ticket.id)}`),snapshot);
console.log('Configurable service structure verified: arbitrary domains, reviewed atomic publication, immutable history, appointments, ticket eligibility, pending recovery and disabled coverage');
