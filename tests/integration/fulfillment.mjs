import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFulfillmentFixture,fulfillmentSql as sql,literal as q } from '../support/fulfillment.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1';
async function request(path,user='agent-2',body,key=randomUUID()) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'X-Dev-User':user,'Content-Type':'application/json','Idempotency-Key':key},
    body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
}
async function ok(promise){const result=await promise;assert.ok([200,201].includes(result.status),JSON.stringify(result));return result.data;}
const get=(f,user)=>request(`/fulfillments/${f.id}`,user);
const action=(f,operation='review',user='agent-2',expectedVersion=1,reference=`EVIDENCE-${randomUUID()}`,key=randomUUID())=>
  request(`/fulfillments/${f.id}/${operation}`,user,{expectedVersion,reference,contentClass:'GENERAL'},key);
const f=await createFulfillmentFixture({includeApplicant:true});
assert.equal((await ok(request('/fulfillments/intake'))).enabled,false,'manual delivery is closed by default');
const gated=await request(`/fulfillments/intake/${f.approvalId}/prepare`,'agent-2',{expectedVersion:0,contentClass:'GENERAL'});
assert.equal(gated.status,503);assert.equal(gated.data.code,'REQUEST_DELIVERY_DISABLED');
const initial=await ok(get(f));
const adminView=await ok(get(f,'demo-admin-1'));
assert.equal(adminView.canReview,false,'read access must not grant the administrator an operator action');
assert.equal((await ok(request(`/fulfillments?group=${f.groupId}`,'demo-admin-1'))).groups.some(g=>g.id===f.groupId),true);
assert.equal((await action(f,'review','demo-admin-1',initial.version)).status,404,'administrator is not automatically a fulfillment operator');
assert.equal(initial.canReview,true);assert.equal(initial.canRevoke,true);
assert.equal(JSON.stringify(initial).includes(f.internalMarker),false,'internal OA fields must not enter the workspace');
for(const user of ['agent-1','employee-1','agent-3']){
  assert.equal((await ok(get(f,user))).canReview,false,'delivery operator, applicant and approver cannot review');
  assert.equal((await action(f,'review',user)).status,403);
}
await sql(`DELETE FROM group_memberships WHERE group_id=${q(f.groupId)} AND employee_id='employee-1'`);
assert.equal((await get(f,'employee-2')).status,404);
assert.equal((await request(`/fulfillments?group=${f.groupId}`,'employee-2')).status,404);
assert.equal((await request('/fulfillments/not-a-uuid')).status,404);
assert.equal((await request('/fulfillments?queue=UNKNOWN')).status,400);
for(const patch of [{expectedVersion:2147483648},{reference:'bad record'},{contentClass:'SECRET'},{unexpected:'field'}]){
  const invalid=await request(`/fulfillments/${f.id}/review`,'agent-2',{expectedVersion:initial.version,reference:'VALID-REFERENCE',contentClass:'GENERAL',...patch});
  assert.equal(invalid.status,400,JSON.stringify(invalid));
}
const missingKey=await fetch(`${base}/fulfillments/${f.id}/review`,{method:'POST',headers:{'X-Dev-User':'agent-2','Content-Type':'application/json'},
  body:JSON.stringify({expectedVersion:initial.version,reference:'VALID-REFERENCE',contentClass:'GENERAL'})});
assert.equal(missingKey.status,400);assert.equal((await missingKey.json()).code,'FULFILLMENT_KEY_REQUIRED');
assert.equal((await request(`/fulfillments/${f.id}/prepare`,'agent-2',{})).status,404);
assert.equal((await request(`/fulfillments/${f.id}/deliver`,'agent-2',{})).status,404);
assert.equal((await action(f,'review','agent-2',initial.version+1)).data.code,'FULFILLMENT_VERSION_CONFLICT');
assert.equal((await action(f,'review','agent-2',initial.version,f.deliveryReference)).data.code,'FULFILLMENT_EVIDENCE_REUSED');
const key=randomUUID(),reference=`REVIEW-${randomUUID()}`;
const concurrent=await Promise.all([action(f,'review','agent-2',initial.version,reference,key),action(f,'review','agent-2',initial.version,reference,key)]);
concurrent.forEach(result=>assert.equal(result.status,200,JSON.stringify(result)));
assert.deepEqual(concurrent[0].data,concurrent[1].data,'same command returns the original receipt');
assert.equal(await sql(`SELECT count(*) FROM request_fulfillment_events WHERE fulfillment_id=${q(f.id)} AND action='DELIVERY_REVIEWED'`),'1');
const reviewed=await ok(get(f));assert.equal(reviewed.version,initial.version+1);assert.equal(reviewed.canReview,false);
assert.equal((await action(f,'review','agent-2',initial.version,'DIFFERENT-REFERENCE',key)).data.code,'FULFILLMENT_KEY_CONFLICT');
assert.equal((await action(f,'review','agent-2',reviewed.version)).data.code,'FULFILLMENT_REVIEW_UNAVAILABLE');
assert.equal((await action(f,'revoke','agent-2',reviewed.version,reference)).data.code,'FULFILLMENT_EVIDENCE_REUSED');
await sql(`UPDATE request_fulfillments SET updated_at=clock_timestamp() WHERE id=${q(f.id)}`);
assert.equal((await ok(get(f))).version,reviewed.version,'maintenance must not invalidate business forms');
const revoked=await ok(action(f,'revoke','agent-2',reviewed.version));
assert.equal(revoked.version,reviewed.version+1);assert.equal((await ok(get(f))).state,'REVOKED');
assert.equal((await action(f,'revoke','agent-2',revoked.version)).data.code,'FULFILLMENT_NOT_DELIVERED');
for(const query of [
  `UPDATE request_fulfillment_commands SET result='{}' WHERE fulfillment_id=${q(f.id)}`,
  `DELETE FROM request_fulfillment_commands WHERE fulfillment_id=${q(f.id)}`,
  `UPDATE request_fulfillment_events SET evidence_reference='ALTERED' WHERE fulfillment_id=${q(f.id)}`,
  `DELETE FROM request_fulfillment_events WHERE fulfillment_id=${q(f.id)}`,
  `UPDATE request_fulfillments SET version=version+1 WHERE id=${q(f.id)}`,
])assert.notEqual((await sql(query,false)).code,0,'receipts/events/version cannot be rewritten');
const requester=await ok(request(`/tickets/${f.ticketId}`,'employee-1'));
assert.ok(requester.requestProgress);assert.equal(JSON.stringify(requester).includes(reference),false);
assert.equal(JSON.stringify(requester).includes(f.deliveryReference),false,'internal evidence is not requester progress');

// A different command with a stale version loses without writing a second event.
const racing=await createFulfillmentFixture();
const raceVersion=(await ok(get(racing))).version;
const race=await Promise.all([action(racing,'review','agent-2',raceVersion),action(racing,'revoke','agent-1',raceVersion)]);
assert.deepEqual(race.map(result=>result.status).sort(),[200,409]);
assert.equal(await sql(`SELECT count(*) FROM request_fulfillment_events WHERE fulfillment_id=${q(racing.id)} AND action IN ('DELIVERY_REVIEWED','REVOCATION_RECORDED')`),'1');

// Replaying a successful command must recheck the employee and current group membership.
const removed=await createFulfillmentFixture(),removedKey=randomUUID(),removedRef=`REVIEW-${randomUUID()}`;
const removedVersion=(await ok(get(removed))).version;
await ok(action(removed,'review','agent-2',removedVersion,removedRef,removedKey));
await sql(`DELETE FROM group_memberships WHERE group_id=${q(removed.groupId)} AND employee_id='agent-2'`);
assert.equal((await get(removed)).status,404);
assert.equal((await action(removed,'review','agent-2',removedVersion,removedRef,removedKey)).status,404);
assert.notEqual((await sql(`SELECT perform_request_fulfillment_action(${q(removed.approvalId)},'agent-2','REVOKE','DIRECT-SQL-CI')`,false)).code,0,
  'shared worker/database action cannot bypass removed membership');

// Current appointments apply to old snapshots immediately; a current group lead can still record emergency revocation.
const appointed=await createFulfillmentFixture({appointed:true}),appointedKey=randomUUID(),appointedRef=`REVIEW-${randomUUID()}`;
const appointedVersion=(await ok(get(appointed))).version;
await ok(action(appointed,'review','agent-2',appointedVersion,appointedRef,appointedKey));
const current=await ok(request('/admin/service-structure','demo-admin-1'));
const config=structuredClone(current.config);
config.appointments.find(a=>a.positionId===appointed.positionId&&a.employeeId==='agent-2').enabled=false;
const proposal=await ok(request('/admin/service-structure','demo-admin-1',{
  id:randomUUID(),expectedVersion:current.version,config,reason:'CI withdraw fulfillment appointment',contentClass:'GENERAL'}));
await ok(request(`/admin/service-structure/${proposal.id}/review`,'demo-admin-2',{
  expectedVersion:proposal.version,decision:'APPROVE',reason:'Independent appointment review',contentClass:'GENERAL'}));
assert.equal((await ok(get(appointed))).canRevoke,false);
assert.equal((await action(appointed,'review','agent-2',appointedVersion,appointedRef,appointedKey)).status,403,'appointment withdrawal also blocks replay');
assert.equal((await action(appointed,'revoke','agent-2',(await ok(get(appointed))).version)).status,403);
assert.notEqual((await sql(`SELECT perform_request_fulfillment_action(${q(appointed.approvalId)},'agent-2','REVOKE','BYPASS-APPOINTMENT')`,false)).code,0);
const lead=await ok(get(appointed,'agent-3'));assert.equal(lead.canRevoke,true);assert.equal(lead.canReview,false);
await ok(action(appointed,'revoke','agent-3',lead.version));

const many=await createFulfillmentFixture({history:110});
const history=await ok(get(many));assert.equal(history.events.length,100);assert.equal(history.eventsHasMore,true);
const pageGroup=`fw-page-${randomUUID()}`;
for(let i=0;i<21;i++)await createFulfillmentFixture({groupId:pageGroup,state:'READY'});
const first=await ok(request(`/fulfillments?queue=ALL&group=${pageGroup}`));
const second=await ok(request(`/fulfillments?queue=ALL&group=${pageGroup}&page=2`));
assert.equal(first.total,21);assert.equal(first.items.length,20);assert.equal(second.items.length,1);
assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,21);
assert.equal((await ok(request(`/fulfillments?queue=UNREVIEWED&group=${pageGroup}`))).total,0);
const blocked=await request('/tickets','employee-1',{serviceCode:f.serviceCode,formVersion:1,subject:'Closed REQ submission',
  description:'CI-only closed boundary',fields:{},impact:'INDIVIDUAL',urgency:'LOW',contentClass:'GENERAL'});
assert.equal(blocked.status,503,JSON.stringify(blocked));assert.equal(blocked.data.code,'REQUEST_APPROVAL_POLICY_NOT_CONFIGURED');
console.log('Fulfillment workspace: scoped history and queues, independent review, current appointments, lead revocation, concurrency, exactly-once replay and immutable evidence verified');
