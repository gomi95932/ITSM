import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user,body,token=randomUUID()) {
  const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':token},
    body:JSON.stringify({contentClass:'GENERAL',...body})});
  return {status:response.status,data:await response.json()};
}
async function get(id,user) {
  const response=await fetch(`${base}/tickets/${id}`,{headers:{'X-Dev-User':user}});
  return {status:response.status,data:await response.json()};
}
async function sql(query,{success=true}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
      '-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],
    {stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.on('error',reject);
    child.on('close',code=>success&&code!==0?reject(new Error('FEEDBACK_SQL_FAILED')):resolve({code,output:output.trim()}));
  });
}
let ticket=await request('/tickets','employee-1',{serviceCode:'INC-BIZ',formVersion:1,subject:`Feedback ${randomUUID()}`,
  description:'WMS login failed',impact:'INDIVIDUAL',urgency:'LOW',fields:{}});
assert.equal(ticket.status,201,JSON.stringify(ticket));
const id=ticket.data.id,path=`/tickets/${id}/feedback`;
assert.equal((await request(path,'employee-1',{rating:5})).status,409);
assert.equal((await request(path,'agent-1',{rating:5})).status,403);
assert.equal((await request(path,'employee-2',{rating:5})).status,404);
assert.equal((await request(path,'employee-1',{rating:0})).status,400);
assert.equal((await request(path,'employee-1',{rating:3.5})).status,400);
assert.equal((await request(path,'employee-1',{rating:4,comment:'x'.repeat(1001)})).status,400);
assert.equal((await request(path,'employee-1',{rating:4,comment:'api_key=secret1234567890'})).status,403);
assert.equal((await get(id,'employee-1')).data.canFeedback,false);
assert.notEqual((await sql(`INSERT INTO ticket_feedback(ticket_id,requester_id,rating) VALUES ('${id}','employee-1',5)`,{success:false})).code,0);
for(const [actor,action,extra] of [['agent-1','ACCEPT',{comment:'Checking'}],
  ['agent-1','RESOLVE',{comment:'Restored',resolutionCategory:'FIX',evidence:'Verified'}],
  ['employee-1','CONFIRM',{}]]) {
  ticket=await request(`/tickets/${id}/actions`,actor,{action,expectedVersion:ticket.data.version,...extra});
  assert.equal(ticket.status,200,JSON.stringify(ticket));
}
const before=await get(id,'employee-1');assert.equal(before.data.canFeedback,true);
const body={rating:4,comment:'处理及时'},key=randomUUID();
const first=await request(path,'employee-1',body,key);assert.equal(first.status,200,JSON.stringify(first));
assert.equal(first.data.rating,4);assert.equal(first.data.comment,body.comment);
assert.deepEqual((await request(path,'employee-1',body,key)).data,first.data);
assert.equal((await request(path,'employee-1',{rating:5},key)).status,409);
assert.equal((await request(path,'employee-1',body)).status,409);
const after=await get(id,'employee-1');assert.equal(after.data.canFeedback,false);
assert.equal(after.data.feedback.comment,body.comment);
assert.equal(after.data.version,before.data.version,'feedback must not change the ticket lifecycle version');
assert.equal((await get(id,'agent-1')).data.feedback.rating,4);
assert.equal((await sql(`SELECT count(*) FROM ticket_feedback WHERE ticket_id='${id}'`)).output,'1');
assert.notEqual((await sql(`UPDATE ticket_feedback SET requester_id='employee-2' WHERE ticket_id='${id}'`,{success:false})).code,0);
assert.equal((await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id
  JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id='${id}' AND e.action='FEEDBACK_SUBMITTED'`)).output,'1');
assert.notEqual((await sql(`UPDATE ticket_feedback SET rating=5 WHERE ticket_id='${id}'`,{success:false})).code,0);
assert.notEqual((await sql(`DELETE FROM ticket_feedback WHERE ticket_id='${id}'`,{success:false})).code,0);
console.log('Ticket feedback permission, immutability, idempotency, content boundary and audit verified');
