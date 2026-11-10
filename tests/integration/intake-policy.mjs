import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base='http://127.0.0.1:8088/api/v1';
const marker='blocked-intake-sentinel';
async function request(path,body,user='employee-1') {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  assert.equal(JSON.stringify(data).includes(marker),false);
  return {status:response.status,data};
}
const config=await request('/intake-policy');
assert.equal(config.data.securityIntakeEnabled,false);
assert.equal(config.data.recordingEnabled,false);
assert.equal((await request('/intake-policy',undefined,'')).status,401);
assert.equal((await request('/voice/config')).data.recordingEnabled,false);
assert.equal((await request('/voice/transcribe',{audio:'YQ==',mimeType:'audio/webm',consent:true,contentClass:'GENERAL'})).status,503);

const body={serviceCode:'INC-BIZ',formVersion:1,subject:'Intake rejection',description:'WMS 无法登录',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}};
const before=await request('/tickets');
assert.equal((await request('/tickets',body)).data.code,'CONTENT_DECLARATION_REQUIRED');
assert.equal((await request('/tickets',{...body,contentClass:'SECURITY_SENSITIVE'})).status,403);
for(const content of [{description:`password=${marker}`},{fields:{system:`sk-${'a'.repeat(24)} ${marker}`}}]) {
  const denied=await request('/tickets',{...body,contentClass:'GENERAL',...content});
  assert.equal(denied.status,403);assert.equal(denied.data.code,'SECURITY_CHANNEL_REQUIRED');
}
assert.equal((await request('/tickets')).data.total,before.data.total);
const ticket=before.data.items[0];assert.ok(ticket);
const detail=(await request(`/tickets/${ticket.id}`)).data;
assert.equal((await request(`/tickets/${ticket.id}/actions`,{action:'ADD_INFO',expectedVersion:ticket.version,contentClass:'GENERAL',comment:`password=${marker}`})).status,403);
const after=(await request(`/tickets/${ticket.id}`)).data;
assert.equal(after.version,detail.version);assert.equal(after.events.length,detail.events.length);
assert.equal((await request('/voice/interpret',{text:'WMS 连接失败'})).data.code,'CONTENT_DECLARATION_REQUIRED');
assert.equal((await request('/voice/interpret',{text:`password=${marker}`,contentClass:'GENERAL'})).status,403);
assert.equal((await request('/voice/interpret',{text:'现场需要支持',contentClass:'SECURITY_SENSITIVE'})).status,403);
console.log('Intake policy passed: direct API declarations, blocked payloads, unchanged tickets, closed recording');
