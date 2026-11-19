import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFulfillmentFixture,fulfillmentSql as sql,literal as q } from '../support/fulfillment.mjs';
import { processDeliveryCommands } from '../support/request-delivery.mjs';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base='http://127.0.0.1:8088/api/v1',root='/fulfillments/delivery-failures';
async function request(path,user='agent-2',body,key=randomUUID()){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'X-Dev-User':user,'Content-Type':'application/json','Idempotency-Key':key},
    body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
}
async function ok(promise,status=200){const result=await promise;assert.equal(result.status,status,JSON.stringify(result));return result.data;}
const body=reference=>({outcome:'NOT_GRANTED',reference,actualVerificationConfirmed:true,contentClass:'GENERAL'});
const resolve=(id,user='agent-2',input=body(`VERIFY-${id}`),key=randomUUID())=>request(`${root}/${id}/resolve`,user,input,key);
const list=(f,user='agent-2',extra='')=>ok(request(`${root}?group=${f.groupId}${extra}`,user));
async function syntheticFailure(f,{old=false,operation='DELIVER'}={}){
  const id=randomUUID();
  await sql(`INSERT INTO request_delivery_commands(id,approval_id,actor_id,request_key,operation,expected_version,evidence_reference,request_hash,
    state,error_code,created_at,expires_at,completed_at) VALUES(${q(id)},${q(f.approvalId)},'agent-1',${q(randomUUID())},${q(operation)},
      ${operation==='DELIVER'?1:0},${operation==='DELIVER'?q(`FAILED-${id}`):'NULL'},repeat('a',64),'REJECTED','DELIVERY_VERIFICATION_FAILED',
      now()-interval '${old?'3 days':'2 minutes'}',now()-interval '${old?'2 days':'1 minute'}',now()-interval '${old?'2 days':'1 minute'}')`);
  return id;
}
async function leader(f){
  await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES('demo-admin-2',${q(f.groupId)});
    INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,source,requested_by,reviewed_by,reason)
      VALUES(${q(randomUUID())},'demo-admin-2','GROUP_LEAD',${q(f.groupId)},now()-interval '1 hour',now()+interval '1 day',
        'ACTIVE','REVIEW','demo-admin-1','agent-3','CI independent fallback verifier')`);
}

const f=await createFulfillmentFixture({state:'READY',appointed:true,includeApplicant:true});
const delivery={expectedVersion:1,reference:`DELIVER-${f.id}`,contentClass:'GENERAL',actualDeliveryConfirmed:true},deliveryKey=randomUUID();
const pending=await ok(request(`/fulfillments/intake/${f.approvalId}/deliver`,'agent-1',delivery,deliveryKey),202);
await processDeliveryCommands('FAIL');
const open=await list(f);assert.equal(open.total,1);assert.equal(open.items[0].id,pending.id);assert.equal(open.items[0].canResolve,true);
assert.equal(open.items[0].reference,delivery.reference);assert.equal(JSON.stringify(open).includes(f.internalMarker),false);
assert.equal((await list(f,'agent-1')).items[0].canResolve,false);
for(const user of ['agent-1','employee-1','agent-3'])assert.equal((await resolve(pending.id,user)).status,403);
assert.equal((await resolve(pending.id,'employee-2')).status,404);
assert.equal((await request(`${root}?group=${f.groupId}`,'employee-2')).status,404);
assert.equal((await request(`${root}?resolved=yes`)).status,400);
assert.equal((await resolve(pending.id,'agent-2',{...body('VERIFY-INVALID'),actualVerificationConfirmed:false})).status,400);
assert.equal((await request(`/fulfillments/intake/${f.approvalId}/deliver`,'agent-1',delivery)).data.code,'DELIVERY_FAILURE_UNRESOLVED');
assert.equal((await ok(request(`/fulfillments/intake?group=${f.groupId}`,'agent-1'))).items[0].canDeliver,false);
await processDeliveryCommands('DIRECT_BLOCKED');
assert.equal(await sql(`SELECT count(*) FROM ticket_events v JOIN audit_logs a ON a.event_id=v.id JOIN outbox_events o ON o.event_id=v.id
  WHERE v.ticket_id=${q(f.ticketId)} AND v.action='DELIVERY_FAILURE_REQUIRED'`),'1');
assert.equal((await resolve(pending.id,'agent-2',body(delivery.reference))).data.code,'FULFILLMENT_EVIDENCE_REUSED');
await sql(`DELETE FROM group_memberships WHERE group_id=${q(f.groupId)} AND employee_id='agent-2'`);
assert.equal((await resolve(pending.id)).status,404);
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES('agent-2',${q(f.groupId)})`);
await sql("UPDATE employees SET active=false WHERE id='agent-2'");
try{assert.ok([401,403].includes((await resolve(pending.id)).status));}
finally{await sql("UPDATE employees SET active=true WHERE id='agent-2'");}
const before=await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${q(f.ticketId)}`);
const original=await sql(`SELECT row_to_json(c)::text FROM request_delivery_commands c WHERE id=${q(pending.id)}`);
const key=randomUUID(),input=body(`VERIFY-${pending.id}`);
const same=await Promise.all([ok(resolve(pending.id,'agent-2',input,key)),ok(resolve(pending.id,'agent-2',input,key))]);
assert.deepEqual(same[0],same[1]);assert.equal(same[0].outcome,'NOT_GRANTED');
await processDeliveryCommands('RESOLVED_NOTICE');
assert.equal((await list(f)).total,0);const history=await list(f,'agent-2','&resolved=true');assert.equal(history.total,1);
assert.equal(history.items[0].resolution.reference,input.reference);assert.equal(history.items[0].canResolve,false);
assert.equal((await resolve(pending.id,'agent-2',{...input,outcome:'REVOKED'},key)).data.code,'DELIVERY_RESOLUTION_KEY_CONFLICT');
assert.equal((await resolve(pending.id)).data.code,'DELIVERY_FAILURE_ALREADY_RESOLVED');
assert.equal(await sql(`SELECT row_to_json(c)::text FROM request_delivery_commands c WHERE id=${q(pending.id)}`),original);
assert.equal(await sql(`SELECT row_to_json(t)::text FROM tickets t WHERE id=${q(f.ticketId)}`),before,'investigation must not alter ticket or SLA');
assert.equal(await sql(`SELECT count(*) FROM ticket_events v JOIN audit_logs a ON a.event_id=v.id JOIN outbox_events o ON o.event_id=v.id
  WHERE v.ticket_id=${q(f.ticketId)} AND v.action='DELIVERY_FAILURE_RESOLVED'`),'1');
for(const query of [`DELETE FROM request_delivery_resolutions WHERE command_id=${q(pending.id)}`,
  `UPDATE request_delivery_resolutions SET outcome='REVOKED' WHERE command_id=${q(pending.id)}`])assert.notEqual((await sql(query,false)).code,0);
const replay=await ok(request(`/fulfillments/intake/${f.approvalId}/deliver`,'agent-1',delivery,deliveryKey),202);
assert.equal(replay.id,pending.id);assert.equal(replay.state,'REJECTED','resolution must not forge success');
await ok(request(`/fulfillments/intake/${f.approvalId}/deliver`,'agent-1',delivery),202);await processDeliveryCommands();
assert.equal(await sql(`SELECT state FROM request_fulfillments WHERE id=${q(f.id)}`),'DELIVERED','only a new explicit operation can record delivery');

const race=await createFulfillmentFixture({state:'READY',appointed:true}),raceId=await syntheticFailure(race);await leader(race);
const raced=await Promise.all([resolve(raceId),resolve(raceId,'demo-admin-2',body(`LEAD-${raceId}`))]);
assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);
assert.equal(await sql(`SELECT count(*) FROM request_delivery_resolutions WHERE command_id=${q(raceId)}`),'1');
const denied=await createFulfillmentFixture({state:'READY',appointed:true}),deniedId=await syntheticFailure(denied);
await sql(`BEGIN; SELECT pg_advisory_xact_lock(71820512); SELECT version FROM service_structure_current WHERE id FOR UPDATE;
  INSERT INTO service_structure_versions(version,config) SELECT v.version+1,jsonb_set(v.config,'{appointments}',
    (SELECT jsonb_agg(CASE WHEN a->>'positionId'=${q(denied.positionId)} AND a->>'employeeId'='agent-2'
      THEN jsonb_set(a,'{enabled}','false') ELSE a END) FROM jsonb_array_elements(v.config->'appointments') a))
    FROM service_structure_current c JOIN service_structure_versions v ON v.version=c.version WHERE c.id;
  UPDATE service_structure_current SET version=version+1 WHERE id; COMMIT;`);
assert.equal((await list(denied)).items[0].canResolve,false);assert.equal((await resolve(deniedId)).status,403);
await leader(denied);assert.equal((await list(denied,'demo-admin-2')).items[0].canResolve,true);
await ok(resolve(deniedId,'demo-admin-2',body(`LEAD-${deniedId}`)));

const active=await createFulfillmentFixture({state:'DELIVERED',appointed:true}),activeId=await syntheticFailure(active);
assert.equal((await list(active)).items[0].canResolve,false);
assert.equal((await resolve(activeId)).data.code,'DELIVERY_RESOLUTION_ACTIVE_GRANT');
const task=await ok(request(`/fulfillments/${active.id}`));
await ok(request(`/fulfillments/${active.id}/revoke`,'agent-2',{expectedVersion:task.version,reference:`REVOKE-${active.id}`,contentClass:'GENERAL'}));
await ok(resolve(activeId,'agent-2',{...body(`VERIFY-${active.id}`),outcome:'REVOKED'}));

const rollback=await createFulfillmentFixture({state:'READY',appointed:true}),rollbackId=await syntheticFailure(rollback),rollbackKey=randomUUID();
await sql(`CREATE FUNCTION ci_resolution_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.action='DELIVERY_FAILURE_RESOLVED' AND NEW.ticket_id=${q(rollback.ticketId)}::uuid THEN RAISE EXCEPTION 'ci-resolution-rollback'; END IF;
  RETURN NEW; END $$;
  CREATE TRIGGER ci_resolution_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ci_resolution_failure()`);
try{assert.equal((await resolve(rollbackId,'agent-2',body(`VERIFY-${rollbackId}`),rollbackKey)).status,500);}
finally{await sql('DROP TRIGGER ci_resolution_failure ON audit_logs; DROP FUNCTION ci_resolution_failure()');}
assert.equal(await sql(`SELECT count(*) FROM request_delivery_resolutions WHERE command_id=${q(rollbackId)}`),'0');
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${q(rollback.ticketId)} AND action='DELIVERY_FAILURE_RESOLVED'`),'0');
await ok(resolve(rollbackId,'agent-2',body(`VERIFY-${rollbackId}`),rollbackKey));
assert.equal((await resolve(rollbackId,'agent-2',body(`VERIFY-${rollbackId}`),key)).data.code,'DELIVERY_RESOLUTION_KEY_CONFLICT');

const durable=await createFulfillmentFixture({state:'BLOCKED'}),durableId=await syntheticFailure(durable,{old:true});
assert.equal((await list(durable)).items[0].id,durableId,'failure obligations survive the recent-receipt window and blocked tasks');
await ok(resolve(durableId));
const prepare=await createFulfillmentFixture({state:null});await syntheticFailure(prepare,{operation:'PREPARE'});
assert.equal((await list(prepare)).total,0,'failed preparation does not assert a possible downstream grant');
const paged=await createFulfillmentFixture({state:'READY'});
for(let n=0;n<21;n++)await syntheticFailure(paged,{old:true});
const page1=await list(paged),page2=await list(paged,'agent-2','&page=2');
assert.equal(page1.total,21);assert.equal(page1.items.length,20);assert.equal(page2.items.length,1);
assert.equal(new Set([...page1.items,...page2.items].map(row=>row.id)).size,21);
console.log('Failed-delivery investigation verified: durable scoped queue, independent current qualification, blocked API/direct-worker retries, immutable original receipts, race/replay safety, explicit new delivery and atomic audit/outbox rollback; downstream providers synthetic');
