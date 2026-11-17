import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFulfillmentFixture,fulfillmentSql as sql,literal as q } from '../support/fulfillment.mjs';
import { processDeliveryCommands } from '../support/request-delivery.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='agent-1',body,key=randomUUID()){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'X-Dev-User':user,'Content-Type':'application/json','Idempotency-Key':key},
    body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
}
async function ok(promise,status=200){const result=await promise;assert.equal(result.status,status,JSON.stringify(result));return result.data;}
const prepare={expectedVersion:0,contentClass:'GENERAL'};
const command=(f,operation,body,user='agent-1',key=randomUUID())=>request(`/fulfillments/intake/${f.approvalId}/${operation}`,user,body,key);
async function item(f,user='agent-1'){
  const result=await ok(request(`/fulfillments/intake?group=${f.groupId}`,user));assert.equal(result.enabled,true);
  assert.equal(JSON.stringify(result).includes(f.internalMarker),false,'OA snapshots and provider errors must not leak');
  return result.items.find(row=>row.approvalId===f.approvalId);
}
async function untouched(f){
  assert.equal(await sql(`SELECT count(*) FROM request_fulfillments WHERE approval_id=${q(f.approvalId)}`),'0');
  assert.equal(await sql(`SELECT count(*) FROM request_fulfillment_events e JOIN request_fulfillments f ON f.id=e.fulfillment_id WHERE f.approval_id=${q(f.approvalId)}`),'0');
}
const f=await createFulfillmentFixture({state:null,appointed:true,includeApplicant:true}),key=randomUUID();
assert.equal((await item(f)).canPrepare,true);assert.equal((await item(f)).canDeliver,false);
for(const user of ['employee-1','agent-3'])assert.equal((await command(f,'prepare',prepare,user)).status,403,'applicant and approver cannot prepare');
assert.equal((await command(f,'prepare',prepare,'employee-2')).status,404);
assert.equal((await command(f,'prepare',{...prepare,expectedVersion:1})).status,400);
const pending=await ok(command(f,'prepare',prepare,'agent-1',key),202);
assert.equal(pending.state,'PENDING');assert.equal(pending.result,null);await untouched(f);
assert.deepEqual(await ok(command(f,'prepare',prepare,'agent-1',key),202),pending);
assert.equal((await command(f,'prepare',prepare)).data.code,'REQUEST_DELIVERY_PENDING');
assert.equal((await item(f)).canPrepare,false);assert.equal((await item(f,'agent-2')).command,null,'receipt belongs only to the actor');
await processDeliveryCommands('CONCURRENT');
const ready=await item(f);assert.equal(ready.taskState,'READY');assert.equal(ready.canDeliver,true);
assert.equal(ready.command.state,'SUCCEEDED');assert.deepEqual(ready.command.result,{taskId:ready.taskId,version:ready.version});
assert.equal(await sql(`SELECT count(*) FROM request_fulfillment_events WHERE fulfillment_id=${q(ready.taskId)} AND action='TASK_PREPARED'`),'1');
assert.deepEqual(await ok(command(f,'prepare',prepare,'agent-1',key),202),ready.command,'lost response replay returns the terminal receipt');
const deliver={expectedVersion:ready.version,reference:`DELIVER-${f.approvalId}`,contentClass:'GENERAL',actualDeliveryConfirmed:true};
assert.equal((await command(f,'deliver',{...deliver,actualDeliveryConfirmed:false})).status,400);
assert.equal((await command(f,'deliver',{...deliver,expectedVersion:ready.version+1})).data.code,'FULFILLMENT_VERSION_CONFLICT');
assert.equal((await command(f,'deliver',deliver,'agent-2')).data.code,'FULFILLMENT_NOT_READY');
assert.equal((await command(f,'deliver',deliver,'agent-1',key)).data.code,'FULFILLMENT_KEY_CONFLICT');
const deliveryKey=randomUUID();await ok(command(f,'deliver',deliver,'agent-1',deliveryKey),202);
assert.equal((await item(f)).taskState,'READY','202 is not a completed delivery');
await processDeliveryCommands('CONCURRENT');
const delivered=await item(f);assert.equal(delivered.taskState,'DELIVERED');assert.equal(delivered.command.state,'SUCCEEDED');
assert.equal(delivered.command.result.version,ready.version+1);
assert.deepEqual(await ok(command(f,'deliver',deliver,'agent-1',deliveryKey),202),delivered.command);
assert.equal(await sql(`SELECT count(*) FROM request_fulfillment_events WHERE fulfillment_id=${q(ready.taskId)} AND action='DELIVERY_RECORDED'`),'1');
await ok(request(`/fulfillments/${ready.taskId}/review`,'agent-2',{expectedVersion:delivered.version,reference:`REVIEW-${f.approvalId}`,contentClass:'GENERAL'}));
for(const query of [`DELETE FROM request_delivery_commands WHERE id=${q(pending.id)}`,
  `UPDATE request_delivery_commands SET state='PENDING',result=NULL,completed_at=NULL WHERE id=${q(pending.id)}`,
  `UPDATE request_delivery_commands SET error_code='rewritten' WHERE id=${q(pending.id)}`])assert.notEqual((await sql(query,false)).code,0);
await sql(`DELETE FROM group_memberships WHERE group_id=${q(f.groupId)} AND employee_id='agent-1'`);
assert.equal((await command(f,'deliver',deliver,'agent-1',deliveryKey)).status,404,'receipt replay rechecks current membership');

for(const [mode,reason] of [['FAIL','DELIVERY_VERIFICATION_FAILED'],['WITHDRAW','FULFILLMENT_PROVIDER_NOT_APPROVED'],['CALLBACK','FULFILLMENT_APPROVAL_UNAVAILABLE']]){
  const blocked=await createFulfillmentFixture({state:null});await ok(command(blocked,'prepare',prepare),202);
  await processDeliveryCommands(mode);const rejected=await item(blocked);
  assert.equal(rejected.command.state,'REJECTED');assert.equal(rejected.command.errorCode,reason);await untouched(blocked);
}
assert.equal(await sql(`SELECT count(*) FROM request_delivery_commands WHERE strpos(row_to_json(request_delivery_commands)::text,'provider-private-error-sentinel')>0`),'0');
const lost=await createFulfillmentFixture({state:null,appointed:true});await ok(command(lost,'prepare',prepare),202);
await sql(`BEGIN; SELECT pg_advisory_xact_lock(71820512); SELECT version FROM service_structure_current WHERE id FOR UPDATE;
  INSERT INTO service_structure_versions(version,config) SELECT v.version+1,jsonb_set(v.config,'{appointments}',
    (SELECT jsonb_agg(CASE WHEN a->>'positionId'=${q(lost.positionId)} AND a->>'employeeId'='agent-1'
      THEN jsonb_set(a,'{enabled}','false') ELSE a END) FROM jsonb_array_elements(v.config->'appointments') a))
    FROM service_structure_current c JOIN service_structure_versions v ON v.version=c.version WHERE c.id;
  UPDATE service_structure_current SET version=version+1 WHERE id; COMMIT;`);
await processDeliveryCommands();assert.equal((await item(lost)).command.errorCode,'FULFILLMENT_OPERATOR_DENIED');await untouched(lost);
const expired=await createFulfillmentFixture({state:null});
await sql(`INSERT INTO request_delivery_commands(approval_id,actor_id,request_key,operation,expected_version,request_hash,created_at,expires_at)
  VALUES(${q(expired.approvalId)},'agent-1',${q(randomUUID())},'PREPARE',0,repeat('a',64),now()-interval '20 minutes',now()-interval '1 minute')`);
await processDeliveryCommands();assert.equal((await item(expired)).command.errorCode,'REQUEST_DELIVERY_COMMAND_EXPIRED');await untouched(expired);

const rollback=await createFulfillmentFixture({state:null});await ok(command(rollback,'prepare',prepare),202);
await sql(`CREATE FUNCTION ci_delivery_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.state='SUCCEEDED' THEN RAISE EXCEPTION 'ci-private-transaction-error'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER ci_delivery_receipt_failure BEFORE UPDATE ON request_delivery_commands FOR EACH ROW EXECUTE FUNCTION ci_delivery_receipt_failure()`);
try{await processDeliveryCommands();}finally{await sql('DROP TRIGGER ci_delivery_receipt_failure ON request_delivery_commands; DROP FUNCTION ci_delivery_receipt_failure()');}
await untouched(rollback);assert.equal((await item(rollback)).command.errorCode,'DELIVERY_VERIFICATION_FAILED','task, event and success receipt are atomic');
await ok(command(rollback,'prepare',prepare),202);await processDeliveryCommands();assert.equal((await item(rollback)).taskState,'READY','new explicit retry can succeed after a failed verification');
const pageGroup=`delivery-page-${randomUUID()}`;
for(let n=0;n<21;n++)await createFulfillmentFixture({state:null,groupId:pageGroup});
const page1=await ok(request(`/fulfillments/intake?group=${pageGroup}`)),page2=await ok(request(`/fulfillments/intake?group=${pageGroup}&page=2`));
assert.equal(page1.total,21);assert.equal(page1.items.length,20);assert.equal(page2.items.length,1);
assert.equal(new Set([...page1.items,...page2.items].map(row=>row.approvalId)).size,21);
console.log('Manual delivery HTTP/worker verified: 202 intent, scoped receipts, exact replay, concurrent workers, authoritative reinspection, callback fencing, appointment withdrawal, expiry and atomic rollback; all providers synthetic');
