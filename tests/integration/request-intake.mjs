import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { intakeCorp, requester, manager, owner, verifier, incidentCode, quote, seedIntake, sql } from '../support/request-intake.mjs';

const base='http://127.0.0.1:8088/api/v1';
async function request(path,body,user=requester,key=randomUUID()) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json','X-Dev-User':user,'Idempotency-Key':key},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
}
const snapshot=await seedIntake();
const body={contentClass:'GENERAL',serviceCode:snapshot.code,formVersion:1,subject:'CI access request',description:'Read access for daily work',
  requestedValidityDays:30,impact:'INDIVIDUAL',urgency:'LOW',fields:{system:'WMS',reason:'Stock inquiry'}};
const create=(overrides={},user=requester,key)=>request('/tickets',{...body,...overrides},user,key);
async function reject(overrides,status,code,user=requester) {
  const key=randomUUID(),result=await create(overrides,user,key);
  assert.equal(result.status,status,JSON.stringify(result));
  if(code)assert.equal(result.data.code,code);
  assert.equal(await sql(`SELECT count(*) FROM api_idempotency WHERE actor_id=${quote(user)} AND scope='create' AND key=${quote(key)}`),'0');
}
const catalog=async()=>{
  const response=await request('/catalog');
  assert.equal(response.status,200);
  return response.data.items.find(item=>item.code===snapshot.code);
};
assert.equal((await catalog()).available,true);
assert.equal((await catalog()).maxValidityDays,90);
await reject({requestedValidityDays:undefined},400,'INVALID_REQUEST_VALIDITY');
await reject({requestedValidityDays:0},400);
await reject({requestedValidityDays:1.5},400);
await reject({requestedValidityDays:91},400,'INVALID_REQUEST_VALIDITY');
await reject({serviceCode:incidentCode,fields:{}},400,'INVALID_REQUEST_VALIDITY');
await reject({fields:{system:'WMS'}},400,'REQUIRED_FIELDS_MISSING');
await reject({fields:{...body.fields,system:'UNKNOWN'}},400,'INVALID_SERVICE_FIELDS');
await reject({},409,'APPROVAL_IDENTITY_UNAVAILABLE','employee-1');
await sql(`UPDATE request_manager_mappings SET review_before=now()+interval '20 minutes' WHERE employee_id=${quote(requester)}`);
await reject({},409,'APPROVAL_MANAGER_MAPPING_UNAVAILABLE');
await sql(`UPDATE request_manager_mappings SET review_before=now()+interval '2 days' WHERE employee_id=${quote(requester)};
  UPDATE employees SET active=false WHERE id=${quote(owner)}`);
await reject({},409,'APPROVAL_IDENTITY_UNAVAILABLE');
await sql(`UPDATE employees SET active=true WHERE id=${quote(owner)};
  UPDATE request_manager_mappings SET manager_id=${quote(owner)} WHERE employee_id=${quote(requester)}`);
await reject({},409,'APPROVAL_SEPARATION_REQUIRED');
await sql(`UPDATE request_manager_mappings SET manager_id=${quote(manager)} WHERE employee_id=${quote(requester)};
  INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(manager)},'service-desk') ON CONFLICT DO NOTHING`);
const delegation=randomUUID();
await sql(`INSERT INTO ticket_delegations(id,requester_id,delegate_id,expires_at)
  VALUES (${quote(delegation)},${quote(requester)},${quote(manager)},now()+interval '1 day')`);
await reject({delegationId:delegation},409,'APPROVAL_SEPARATION_REQUIRED',manager);
assert.equal(await sql(`SELECT count(*) FROM tickets WHERE service_code=${quote(snapshot.code)}`),'0');

// Fail after the approval, SLA and audit have been written, while the transaction is still open.
const draft=randomUUID(),failedSubject='CI request rollback probe';
await sql(`INSERT INTO voice_drafts(id,employee_id,candidate) VALUES (${quote(draft)},${quote(requester)},'{}');
  CREATE SEQUENCE ci_request_outbox_probe;
  CREATE FUNCTION ci_fail_request_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS(SELECT 1 FROM tickets t JOIN request_approvals a ON a.ticket_id=t.id
      JOIN sla_cycles s ON s.ticket_id=t.id JOIN audit_logs l ON l.event_id=NEW.event_id
      WHERE t.id=NEW.ticket_id AND t.subject=${quote(failedSubject)}) THEN
      PERFORM nextval('ci_request_outbox_probe');
      RAISE EXCEPTION 'CI_REQUEST_OUTBOX_FAILURE';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER ci_fail_request_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION ci_fail_request_outbox()`);
try {
  await reject({subject:failedSubject,draftId:draft},500);
  assert.equal(await sql('SELECT is_called FROM ci_request_outbox_probe'),'t','failure must come from the final outbox write');
  assert.equal(await sql(`SELECT count(*) FROM tickets WHERE service_code=${quote(snapshot.code)}`),'0');
  assert.equal(await sql(`SELECT ticket_id IS NULL FROM voice_drafts WHERE id=${quote(draft)}`),'t');
} finally {
  await sql('DROP TRIGGER ci_fail_request_outbox ON outbox_events; DROP FUNCTION ci_fail_request_outbox(); DROP SEQUENCE ci_request_outbox_probe');
}

const key=randomUUID();
const [first,replay]=await Promise.all([create({},requester,key),create({},requester,key)]);
assert.equal(first.status,201,JSON.stringify(first));
assert.deepEqual(replay,first);
assert.equal(first.data.status,'WAITING_APPROVAL');
assert.equal((await create({requestedValidityDays:31},requester,key)).data.code,'IDEMPOTENCY_KEY_REUSED');
const id=quote(first.data.id);
const stored=JSON.parse(await sql(`SELECT json_build_object('catalog',t.catalog_snapshot,'original',t.original_catalog_snapshot,
  'approval',a.snapshot,'state',a.state,'corp',a.corp_id,'provider',a.provider_instance_id,
  'timeout',extract(epoch FROM a.expires_at-a.created_at)::integer,
  'pause',s.pause_reason,'paused',s.paused_at IS NOT NULL,
  'approvalEvents',(SELECT count(*) FROM request_approval_events e WHERE e.approval_id=a.id AND e.action='APPROVAL_QUEUED'),
  'records',(SELECT count(*) FROM ticket_events e JOIN audit_logs l ON l.event_id=e.id JOIN outbox_events o ON o.event_id=e.id
    WHERE e.ticket_id=t.id AND e.action='SUBMIT_AND_ROUTE'))
  FROM tickets t JOIN request_approvals a ON a.ticket_id=t.id JOIN sla_cycles s ON s.ticket_id=t.id WHERE t.id=${id}`));
assert.deepEqual(stored.catalog,snapshot);
assert.deepEqual(stored.original,snapshot);
assert.deepEqual(stored.approval.request.fields,body.fields);
assert.equal(stored.approval.requestedValidityDays,30);
assert.equal(stored.approval.applicant.employeeId,requester);
assert.deepEqual(stored.approval.approvers.map(item=>[item.role,item.employeeId]),[['MANAGER',manager],['SYSTEM_OWNER',owner]]);
assert.equal(stored.corp,intakeCorp);
assert.equal(stored.provider,null);
assert.equal(stored.state,'QUEUED');
assert.equal(stored.timeout,3600);
assert.equal(stored.pause,'APPROVAL');
assert.equal(stored.paused,true);
assert.equal(stored.approvalEvents,1);
assert.equal(stored.records,1);
assert.equal(await sql(`SELECT count(*) FROM tickets WHERE service_code=${quote(snapshot.code)}`),'1');
assert.equal((await request(`/tickets/${first.data.id}`)).data.requestProgress.approval.state,'QUEUED');
assert.equal((await request(`/tickets/${first.data.id}`,undefined,verifier)).status,404);

const cancel=(ticket,version=ticket.version,user=requester,key)=>request(`/tickets/${ticket.id}/actions`,
  {contentClass:'GENERAL',action:'CANCEL',expectedVersion:version},user,key);
assert.equal((await cancel(first.data,first.data.version,manager)).status,403);
assert.equal((await cancel(first.data,first.data.version,verifier)).status,404);
assert.equal((await cancel(first.data,first.data.version+1)).data.code,'VERSION_CONFLICT');
const cancelKey=randomUUID();
const [cancelled,cancelReplay]=await Promise.all([cancel(first.data,undefined,requester,cancelKey),cancel(first.data,undefined,requester,cancelKey)]);
assert.ok([200,201].includes(cancelled.status),JSON.stringify(cancelled));
assert.equal(cancelled.data.status,'CANCELLED');
assert.equal(cancelled.data.version,first.data.version+1);
assert.deepEqual(cancelReplay,cancelled);
assert.equal((await cancel(cancelled.data)).data.code,'INVALID_TRANSITION');
assert.equal((await request(`/tickets/${first.data.id}`)).data.requestProgress.cancellation,'NOT_SENT');
assert.equal(await sql(`SELECT a.state||':'||a.last_error||':'||(s.completed_at IS NOT NULL)::text||':'||(s.responded_at IS NULL)::text
  FROM request_approvals a JOIN sla_cycles s ON s.ticket_id=a.ticket_id WHERE a.ticket_id=${id}`),'BLOCKED:REQUEST_CANCELLED:true:true');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs l ON l.event_id=e.id
  JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id=${id} AND e.action='CANCEL'`),'1');
assert.equal(await sql(`SELECT count(*) FROM request_approval_events e JOIN request_approvals a ON a.id=e.approval_id
  WHERE a.ticket_id=${id} AND e.reason_code='REQUEST_CANCELLED'`),'1');

const pending=await create({subject:'CI request with an in-flight OA submission'});
assert.equal(pending.status,201);
const pendingId=quote(pending.data.id),lease=quote(randomUUID());
await sql(`UPDATE request_approvals SET state='CREATING',creation_attempts=1,lease_token=${lease},lease_until=now()+interval '1 minute'
  WHERE ticket_id=${pendingId}`);
assert.equal((await cancel(pending.data)).data.status,'CANCELLED');
assert.equal(await sql(`SELECT lease_token=${lease} FROM request_approvals WHERE ticket_id=${pendingId}`),'t');
assert.equal((await request(`/tickets/${pending.data.id}`)).data.requestProgress.cancellation,'OA_CREATION_UNCERTAIN');

await sql(`INSERT INTO request_catalog_publishers(employee_id,service_code) VALUES (${quote(verifier)},${quote(snapshot.code)})`);
const published=await request(`/request-catalog/${snapshot.code}/versions`,{
  contentClass:'GENERAL',expectedVersion:1,name:'CI request intake revised',description:snapshot.description,
  groupId:snapshot.groupId,visibleGroups:snapshot.visibleGroups,fields:snapshot.fields,approval:snapshot.approval,maxValidityDays:90,
},verifier);
assert.equal(published.status,201,JSON.stringify(published));
assert.equal(published.data.formVersion,2);
assert.equal((await catalog()).available,false);
await reject({formVersion:1},409,'FORM_VERSION_CONFLICT');
await reject({formVersion:2},503,'REQUEST_APPROVAL_POLICY_NOT_CONFIGURED');
assert.deepEqual((await create({},requester,key)).data,first.data);
console.log('REQ intake and cancellation verified: atomic approval and SLA, restricted catalog versions, same-key replay, actor separation and rollback');
