import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='employee-1',method='GET',body){
  const declared=body && (path==='/tickets'||path.endsWith('/actions')||path==='/voice/interpret') ? {contentClass:'GENERAL',...body}:body;
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':randomUUID()},body:declared===undefined?undefined:JSON.stringify(declared)});
  return {status:response.status,data:await response.json()};
}
assert.equal((await request('/auth/config')).data.mode,'development');
assert.equal((await request('/auth/me')).data.id,'employee-1');
assert.equal((await request('/auth/me','')).status,401);
assert.equal((await request('/auth/dingtalk','employee-1','POST',{code:'invalid123'})).status,401);
assert.deepEqual(
  (await request('/catalog')).data.items.filter(item=>item.available).map(item=>item.code).sort(),
  ['GEN-OTHER','INC-BIZ','INC-MAIL','INC-NET','INC-PC']
);
assert.equal((await request('/support-groups')).status,404);
assert.equal((await request('/notifications')).status,404);
assert.equal((await request('/voice/config')).data.recordingEnabled,false);
assert.equal((await request('/voice/transcribe','employee-1','POST',{audio:'YQ==',mimeType:'audio/webm',consent:true})).status,503);
const draft=await request('/voice/interpret','employee-1','POST',{text:'WMS 无法登录，页面一直报错'});
assert.equal(draft.status,200);assert.equal(draft.data.candidate.serviceCode,'INC-BIZ');assert.equal(draft.data.candidate.requiresReview,true);
const body={serviceCode:'INC-BIZ',formVersion:1,subject:'SLA integration',description:'WMS fails',impact:'COMPANY',urgency:'HIGH',fields:{system:'WMS'},draftId:draft.data.id};
assert.equal((await request('/tickets','employee-2','POST',body)).status,409);
const created=await request('/tickets','employee-1','POST',body);assert.equal(created.status,201,JSON.stringify(created));
assert.equal((await request('/tickets','employee-1','POST',body)).status,409);
assert.equal((await request('/tickets','employee-1','POST',{...body,draftId:undefined,fields:{system:'not-allowed'}})).status,400);
assert.equal((await request('/tickets','employee-1','POST',{...body,draftId:undefined,serviceCode:'REQ-PERM',fields:{}})).status,503);
const id=created.data.id;
let version=1;
async function action(user,action,extra={}){const result=await request(`/tickets/${id}/actions`,user,'POST',{action,expectedVersion:version,...extra});assert.equal(result.status,200,JSON.stringify(result));version=result.data.version;return result;}
assert.equal((await request(`/tickets/${id}/actions`,'agent-1','POST',{action:'ACCEPT',expectedVersion:version})).status,400);
await action('agent-1','ACCEPT',{comment:'正在排查 WMS 登录问题'});
await action('agent-1','REQUEST_INFO',{comment:'请提供报错时间',dueAt:new Date(Date.now()+3600000).toISOString()});
assert.equal((await request(`/tickets/${id}`)).data.sla[0].paused,true);
await action('employee-1','ADD_INFO',{comment:'今天上午十点开始'});
assert.equal((await request(`/tickets/${id}`)).data.sla[0].paused,false);
await action('agent-1','WAIT_VENDOR',{comment:'联系厂商',vendorReference:'vendor-001',vendorOwner:'service desk'});
assert.equal((await request(`/tickets/${id}`)).data.sla[0].paused,false);
await action('agent-1','RESOLVE',{comment:'已恢复',resolutionCategory:'FIX',evidence:'登录验证'});
assert.equal((await request(`/tickets/${id}`)).data.sla[0].completed,true);
await action('employee-1','REOPEN',{reason:'再次出现问题'});
const cycles=(await request(`/tickets/${id}`)).data.sla;assert.equal(cycles.length,2);assert.equal(cycles[0].completed,true);assert.equal(cycles[1].completed,false);
await action('agent-1','REASSIGN',{targetGroupId:'applications',targetAssigneeId:'agent-2',reason:'应用侧继续排查'});
assert.equal((await request(`/tickets/${id}`,'agent-1')).status,200);
assert.equal((await request(`/tickets/${id}`,'agent-2')).status,200);
await action('agent-2','ACCEPT_HANDOVER',{comment:'应用支持已接收'});
assert.equal((await request(`/tickets/${id}`,'agent-1')).status,404);
assert.equal((await request(`/tickets/${id}`,'agent-2')).status,200);
await action('agent-2','RESOLVE',{comment:'问题解决',resolutionCategory:'FIX',evidence:'重新登录成功'});
await action('employee-1','CONFIRM');
// Fake delivery must never count as a real first response.
await new Promise(resolve=>setTimeout(resolve,3000));
assert.equal((await request(`/tickets/${id}`)).data.sla[0].responded,false);
const notes=await request('/notifications','agent-2');assert.equal(notes.status,200);assert.equal(notes.data.mode,'fake');
assert.equal(notes.data.items.some(item=>item.state==='DELIVERED'),false);
console.log('Workspace integration passed: auth, catalog, voice review, SLA cycles, transfer boundaries, fake delivery');
