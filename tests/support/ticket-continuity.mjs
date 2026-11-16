import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export const quote=value=>`'${String(value).replaceAll("'","''")}'`;
export async function request(path,user,body,key=randomUUID()){
  const response=await fetch('http://127.0.0.1:8088/api/v1'+path,{method:body?'POST':'GET',
    headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},
    body:body?JSON.stringify({contentClass:'GENERAL',...body}):undefined});
  return {status:response.status,data:await response.json()};
}
export async function sql(query){
  if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml',
      'exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],{stdio:['ignore','pipe','pipe']});
    let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
    child.once('error',reject);child.once('close',code=>code===0?resolve(output.trim()):reject(new Error(`CONTINUITY_FIXTURE_SQL_FAILED ${error.split('\n').find(line=>line.startsWith('ERROR:'))?.slice(0,180)??''}`)));
  });
}
export async function ok(promise){const result=await promise;assert.ok([200,201].includes(result.status),JSON.stringify(result));return result.data;}
export const action=(ticket,user,action,extra={},key)=>request(`/tickets/${ticket.id}/actions`,user,{action,expectedVersion:ticket.version,...extra},key);
export async function until(check){for(let n=0;n<80;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('CONTINUITY_SCAN_TIMEOUT');}

export async function fixture(){
  const suffix=randomUUID(),group=`continuity-${suffix}`,owner=`owner-${suffix}`,peer=`peer-${suffix}`,lead=`lead-${suffix}`,reviewer=`reviewer-${suffix}`;
  const domain=`domain-${suffix}`,position=`position-${suffix}`;
  await sql(`INSERT INTO employees(id,display_name) VALUES(${quote(owner)},'连续性工程师'),(${quote(peer)},'接替工程师'),
    (${quote(lead)},'值班组长'),(${quote(reviewer)},'复核组长');
    INSERT INTO support_groups(id,name) VALUES(${quote(group)},'连续性验证组');
    INSERT INTO group_memberships(employee_id,group_id) VALUES
      (${quote(owner)},${quote(group)}),(${quote(peer)},${quote(group)}),(${quote(lead)},${quote(group)}),(${quote(reviewer)},${quote(group)});
    INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,requested_by,reviewed_by,reason)
      VALUES(gen_random_uuid(),${quote(lead)},'GROUP_LEAD',${quote(group)},now()-interval '1 minute',now()+interval '1 day','ACTIVE','demo-admin-1','demo-admin-2','CI scoped supervisor'),
      (gen_random_uuid(),${quote(reviewer)},'GROUP_LEAD',${quote(group)},now()-interval '1 minute',now()+interval '1 day','ACTIVE','demo-admin-1','demo-admin-2','CI independent supervisor');`);
  async function publish(change){
    const current=await ok(request('/admin/service-structure','demo-admin-1'));
    const config=structuredClone(current.config);change(config);
    const proposal=await ok(request('/admin/service-structure','demo-admin-1',{id:randomUUID(),expectedVersion:current.version,config,reason:'CI continuity appointment'}));
    await ok(request(`/admin/service-structure/${proposal.id}/review`,'demo-admin-2',{expectedVersion:proposal.version,decision:'APPROVE',reason:'Independent continuity configuration review'}));
  }
  await publish(config=>{
    config.domains.push({id:domain,name:'连续性验证域',enabled:true});
    config.positions.push({id:position,name:'连续性验证岗位',domainId:domain,groupId:group,enabled:true});
    for(const employeeId of [owner,peer])config.appointments.push({id:randomUUID(),positionId:position,employeeId,duty:'PRIMARY',
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),enabled:true});
  });
  const snapshot={version:1,domainId:domain,systemId:null,primaryPositionId:position,positions:[{id:position,name:'连续性验证岗位',groupId:group}]};
  async function create(){
    const ticket=await ok(request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:`Continuity ${randomUUID()}`,
      description:'普通服务处理责任验证',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}}));
    // Scope fixture ownership without changing shared service routes or browser identities.
    await sql(`UPDATE tickets SET owner_group_id=${quote(group)},service_routing_snapshot=${quote(JSON.stringify(snapshot))}::jsonb WHERE id=${quote(ticket.id)}`);
    const current=await ok(request(`/tickets/${ticket.id}`,owner));
    return ok(action(current,owner,'ACCEPT',{comment:'已接收并开始排查'}));
  }
  async function appoint(enabled,employee=owner){await publish(config=>{
    for(const item of config.appointments)if(item.positionId===position&&item.employeeId===employee)item.enabled=enabled;
  });}
  return {group,owner,peer,lead,reviewer,create,appoint};
}
