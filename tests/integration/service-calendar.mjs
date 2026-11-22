import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='demo-admin-1',body){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':randomUUID()},body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
async function sql(query,{success=true}={}){return new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
  let text='';child.stdout.on('data',c=>{text+=c;});child.stderr.resume();child.on('error',reject);child.on('close',code=>success&&code!==0?reject(new Error('CALENDAR_SQL_FAILED')):resolve({code,text:text.trim()}));
});}
const q=v=>`'${String(v).replaceAll("'","''")}'`;
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
const create=async()=>ok(await request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:'Calendar snapshot fixture',description:'One workstation requires assistance',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}}),201);
const snapshot=async ticket=>(await sql(`SELECT calendar_snapshot::text FROM sla_cycles WHERE ticket_id=${q(ticket.id)} ORDER BY cycle DESC LIMIT 1`)).text;
const current=ok(await request('/admin/sla-calendar')).current;
assert.equal((await request('/admin/sla-calendar','employee-1')).status,403);
assert.equal((await request('/admin/sla-calendar','agent-1')).status,403);
const before=await create(),oldSnapshot=await snapshot(before);
const config={...current.config,startHour:8,endHour:17,holidays:['2026-12-25'],workdays:['2026-12-26']};
const body={id:randomUUID(),expectedVersion:current.version,config,reason:'Fixture holiday calendar'};
const proposal=ok(await request('/admin/sla-calendar','demo-admin-1',body),201);
assert.equal(ok(await request('/admin/sla-calendar','demo-admin-1',body),201).id,proposal.id);
assert.equal((await request('/admin/sla-calendar','demo-admin-1',{...body,reason:'Changed reason'})).status,409);
assert.equal((await request('/admin/sla-calendar','employee-1',{...body,id:randomUUID()})).status,403);
assert.equal(ok(await request('/admin/sla-calendar')).current.version,current.version,'pending proposals cannot affect clocks');
const review={expectedVersion:1,decision:'APPROVE',reason:'Independent fixture review'};
assert.equal((await request(`/admin/sla-calendar/${proposal.id}/review`,'demo-admin-1',review)).status,403);
const sibling=ok(await request('/admin/sla-calendar','demo-admin-1',{...body,id:randomUUID()}),201);
ok(await request(`/admin/sla-calendar/${proposal.id}/review`,'demo-admin-2',review),201);
assert.equal((await request(`/admin/sla-calendar/${proposal.id}/review`,'demo-admin-2',review)).status,409);
assert.equal((await request(`/admin/sla-calendar/${sibling.id}/review`,'demo-admin-2',review)).status,409);
ok(await request(`/admin/sla-calendar/${sibling.id}/review`,'demo-admin-2',{...review,decision:'REJECT'}),201);
assert.equal(await snapshot(before),oldSnapshot,'running clocks retain the complete calendar snapshot');
const after=await create(),newSnapshot=JSON.parse(await snapshot(after));
assert.equal(newSnapshot.version,current.version+1);assert.equal(newSnapshot.approved,true);assert.equal(newSnapshot.startHour,8);
assert.deepEqual(newSnapshot.holidays,config.holidays);assert.deepEqual(newSnapshot.workdays,config.workdays);
assert.notEqual((await sql(`UPDATE sla_calendars SET approved=false WHERE version=${current.version+1}`,{success:false})).code,0);
assert.notEqual((await sql(`DELETE FROM sla_calendars WHERE version=${current.version+1}`,{success:false})).code,0);
for(const patch of [{endHour:8},{holidays:['2026-02-30']},{holidays:['2026-12-25'],workdays:['2026-12-25']}]){
  assert.equal((await request('/admin/sla-calendar','demo-admin-1',{...body,id:randomUUID(),expectedVersion:current.version+1,config:{...config,...patch}})).status,400);
}
assert.equal((await request('/admin/sla-calendar','demo-admin-1',{...body,id:randomUUID(),expectedVersion:current.version+1,contentClass:'SECURITY_SENSITIVE'})).status,403);
const inactive=ok(await request('/admin/sla-calendar','demo-admin-1',{...body,id:randomUUID(),expectedVersion:current.version+1}),201);
await sql("UPDATE employees SET active=false WHERE id='demo-admin-1'");
try{assert.equal((await request(`/admin/sla-calendar/${inactive.id}/review`,'demo-admin-2',review)).status,409);}
finally{await sql("UPDATE employees SET active=true WHERE id='demo-admin-1'");}
ok(await request(`/admin/sla-calendar/${inactive.id}/review`,'demo-admin-2',{...review,decision:'REJECT'}),201);
// Restore the effective configuration through the same reviewed API, never by editing a historical version.
const restore=ok(await request('/admin/sla-calendar','demo-admin-1',{...body,id:randomUUID(),expectedVersion:current.version+1,config:current.config,reason:'Restore CI calendar'}),201);
ok(await request(`/admin/sla-calendar/${restore.id}/review`,'demo-admin-2',review),201);
assert.equal((await sql(`SELECT count(*) FROM operational_audits WHERE target_id=${q(proposal.id)} AND action IN ('SLA_CALENDAR_PROPOSED','SLA_CALENDAR_APPROVE')`)).text,'2');
console.log('Service calendar: scope, independent approval, version conflict, replay, immutable history, inactive proposer and SLA snapshots passed');
