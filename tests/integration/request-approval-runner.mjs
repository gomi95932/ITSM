import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { enqueueRequestApproval, maintainRequestApprovals, processNextRequestApproval, queueVerifiedApprovalHint } from './apps/worker/dist/request-approval.js';
import { prepareRequestFulfillment, recordRequestDelivery, reviewRequestDelivery, recordRequestRevocation, maintainRequestFulfillments, processNextRequestDelivery } from './apps/worker/dist/request-fulfillment.js';

if (process.env.ITSM_APPROVAL_CI !== 'true' || process.env.NODE_ENV === 'production') throw new Error('DISPOSABLE_APPROVAL_CI_ONLY');
const db = new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  application_name:'itsm-oa-ci',max:6});
const corp = 'ci-approval-corp';
const roles = ['requester','manager','owner','verifier','reviewer'];
const employee = role => `oa-ci-${role}`;
const catalog = {code:'REQ-OA-CI',formVersion:1,published:true,name:'CI approval fixture',description:'Disposable tests only',
  groupId:'oa-ci-group',visibleGroups:[],fields:[],maxValidityDays:90,
  approval:{templateId:'CI-APPROVAL-TEMPLATE',steps:[{role:'MANAGER'},{role:'SYSTEM_OWNER',approverId:employee('owner')}]}};
async function transaction(fn) {
  const client = await db.connect();
  try {await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result;}
  catch(error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
}
async function mapping() {
  await db.query(`INSERT INTO request_manager_mappings(employee_id,manager_id,source_reference,verified_by,review_before)
    VALUES ($1,$2,'CI-MANAGER-REFERENCE',$3,now()+interval '2 days') ON CONFLICT (employee_id) DO UPDATE
    SET manager_id=EXCLUDED.manager_id,source_reference=EXCLUDED.source_reference,verified_by=EXCLUDED.verified_by,
      verified_at=now(),review_before=EXCLUDED.review_before`,[employee('requester'),employee('manager'),employee('verifier')]);
}
async function draft(client=db,routing={}) {
  const id=randomUUID();
  await client.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,
    form_version,subject,description,fields,impact,urgency,priority,status,catalog_snapshot,service_routing_snapshot)
    VALUES ($1,$2,$3,$3,'oa-ci-group','REQ-OA-CI','REQ',1,'Approval fixture','No real request','{}','INDIVIDUAL','LOW','P4','WAITING_APPROVAL',$4,$5)`,
    [id,`OA-CI-${id}`,employee('requester'),JSON.stringify(catalog),JSON.stringify(routing)]);
  return id;
}
const row = async id => (await db.query('SELECT * FROM request_approvals WHERE id=$1',[id])).rows[0];
async function enqueue(ticketId,expiresAt=new Date(Date.now()+3600000),requestedValidityDays=30) {
  const input={ticketId,corpId:corp,expiresAt,requestedValidityDays};
  return {id:await transaction(client=>enqueueRequestApproval(client,input)),input};
}
const fresh = async () => enqueue(await draft());
async function retire(id) {
  await db.query("UPDATE tickets SET status='CANCELLED' WHERE id=(SELECT ticket_id FROM request_approvals WHERE id=$1)",[id]);
  await maintainRequestApprovals(db);
}
const records=new Map();
const references=new Map();
let creates=0;
const provider={
  async create(input) {
    creates++;
    const instanceId=`CI-INSTANCE-${input.reference}`;
    records.set(instanceId,{instanceId,corpId:input.corpId,templateId:input.snapshot.templateId,
      applicantDingUserId:input.snapshot.applicant.dingUserId,approverDingUserIds:input.snapshot.approvers.map(p=>p.dingUserId),state:'PENDING',
      requestBinding:{reference:input.reference,serviceCode:input.snapshot.serviceCode,formVersion:input.snapshot.formVersion,
        requestedValidityDays:input.snapshot.requestedValidityDays,request:structuredClone(input.snapshot.request)}});
    references.set(input.reference,instanceId);
    return {instanceId};
  },
  async inspect(instanceId) {assert.ok(records.has(instanceId)); return structuredClone(records.get(instanceId));},
  async recoverCreated(reference) {const instanceId=references.get(reference); return instanceId?{instanceId}:null;},
};
async function processApproval(id,adapter=provider) {
  await db.query("UPDATE request_approvals SET next_at=now()-interval '1 day' WHERE id=$1",[id]);
  assert.equal(await processNextRequestApproval(db,adapter),true);
  const processed=await row(id);
  assert.ok(processed.next_at > new Date(Date.now()-60_000) || ['BLOCKED','EXPIRED'].includes(processed.state),
    'the targeted approval must have been processed');
  return processed;
}
async function hint(id,eventId=randomUUID(),extras={}) {
  const approval=await row(id);
  return transaction(client=>queueVerifiedApprovalHint(client,{corpId:corp,instanceId:approval.provider_instance_id,eventId,...extras}));
}
try {
  for (const role of roles) {
    await db.query('INSERT INTO employees(id,display_name) VALUES ($1,$2)',[employee(role),`CI ${role}`]);
    await db.query('INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES ($1,$2,$3)',[corp,`CI-DING-${role}`,employee(role)]);
  }
  await db.query("INSERT INTO support_groups(id,name) VALUES ('oa-ci-group','CI approvals')");
  await db.query("INSERT INTO group_memberships(employee_id,group_id) VALUES ($1,'oa-ci-group')",[employee('verifier')]);
  await db.query("INSERT INTO group_memberships(employee_id,group_id) VALUES ($1,'oa-ci-group')",[employee('reviewer')]);
  await db.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id,name) VALUES ('REQ-OA-CI','REQ',1,true,'oa-ci-group','CI approval fixture')`);
  await db.query("INSERT INTO request_catalog_versions(service_code,form_version,snapshot) VALUES ('REQ-OA-CI',1,$1)",[JSON.stringify(catalog)]);
  const unavailable=await draft();
  await assert.rejects(enqueue(unavailable),/APPROVAL_MANAGER_MAPPING_UNAVAILABLE/);
  await mapping();
  await assert.rejects(enqueue(unavailable,new Date(Date.now()+3600000),91),/APPROVAL_CATALOG_NOT_READY/);
  await db.query('DELETE FROM identity_links WHERE employee_id=$1',[employee('owner')]);
  await assert.rejects(enqueue(unavailable),/APPROVAL_IDENTITY_UNAVAILABLE/);
  await db.query('INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES ($1,$2,$3)',[corp,'CI-DING-owner',employee('owner')]);
  await db.query('UPDATE request_manager_mappings SET manager_id=$2 WHERE employee_id=$1',[employee('requester'),employee('requester')]).then(
    ()=>assert.fail('self manager accepted'),()=>{});

  const beforeTickets=Number((await db.query('SELECT count(*) FROM tickets')).rows[0].count);
  const beforeApprovals=Number((await db.query('SELECT count(*) FROM request_approvals')).rows[0].count);
  await assert.rejects(transaction(async client=>{
    const ticketId=await draft(client);
    await enqueueRequestApproval(client,{ticketId,corpId:corp,expiresAt:new Date(Date.now()+3600000),requestedValidityDays:30});
    throw new Error('ROLLBACK_INTENT');
  }),/ROLLBACK_INTENT/);
  assert.equal(Number((await db.query('SELECT count(*) FROM tickets')).rows[0].count),beforeTickets);
  assert.equal(Number((await db.query('SELECT count(*) FROM request_approvals')).rows[0].count),beforeApprovals,
    'rolled-back intent must not add approval records, including on a populated database');

  const normal=await fresh();
  assert.equal(await transaction(client=>enqueueRequestApproval(client,normal.input)),normal.id,'same intent is idempotent');
  await assert.rejects(transaction(client=>enqueueRequestApproval(client,{...normal.input,requestedValidityDays:31})),/APPROVAL_INTENT_CONFLICT/);
  const snap=(await row(normal.id)).snapshot;
  assert.deepEqual(snap.approvers.map(p=>p.employeeId),[employee('manager'),employee('owner')]);
  assert.equal(snap.managerMapping.sourceReference,'CI-MANAGER-REFERENCE');
  await assert.rejects(db.query("UPDATE request_approvals SET snapshot='{}' WHERE id=$1",[normal.id]),/REQUEST_APPROVAL_IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM request_approvals WHERE id=$1',[normal.id]),/REQUEST_APPROVAL_IMMUTABLE/);
  const created=await processApproval(normal.id);
  assert.equal(created.state,'PENDING');
  const duplicateEvent=randomUUID();
  assert.equal(await hint(normal.id,duplicateEvent,{state:'APPROVED'}),true);
  assert.equal(await hint(normal.id,duplicateEvent),false);
  assert.equal((await row(normal.id)).state,'PENDING','callback content never approves');
  assert.equal(await hint(normal.id,randomUUID(),{corpId:'wrong-corp'}),false);
  assert.equal(await hint(normal.id,randomUUID(),{instanceId:'unknown-instance'}),false);
  assert.equal((await processApproval(normal.id)).state,'PENDING','only authoritative queries determine state');
  records.get(created.provider_instance_id).state='APPROVED';
  assert.equal((await processApproval(normal.id)).state,'APPROVED');
  assert.equal((await db.query('SELECT status FROM tickets WHERE id=$1',[normal.input.ticketId])).rows[0].status,'WAITING_APPROVAL','approval is not fulfillment');
  records.get(created.provider_instance_id).state='WITHDRAWN';
  await hint(normal.id);
  assert.equal((await processApproval(normal.id)).state,'WITHDRAWN');
  records.get(created.provider_instance_id).state='APPROVED';
  await hint(normal.id);
  assert.equal(await processNextRequestApproval(db,provider),false,'late hint cannot resurrect withdrawn request');
  assert.equal((await row(normal.id)).state,'WITHDRAWN');
  await assert.rejects(db.query("UPDATE request_approval_events SET reason_code='changed' WHERE approval_id=$1",[normal.id]),/REQUEST_CATALOG_VERSION_IMMUTABLE/);

  const rejected=await fresh(); const rejectedRow=await processApproval(rejected.id);
  records.get(rejectedRow.provider_instance_id).state='REJECTED';
  assert.equal((await processApproval(rejected.id)).state,'REJECTED');

  for (const change of [
    observation=>{observation.corpId='other';},observation=>{observation.templateId='other';},
    observation=>{observation.applicantDingUserId='other';},observation=>{observation.approverDingUserIds.reverse();},
    observation=>{observation.requestBinding.reference=randomUUID();},
    observation=>{observation.requestBinding.serviceCode='REQ-OTHER';},
    observation=>{observation.requestBinding.formVersion++;},
    observation=>{observation.requestBinding.requestedValidityDays++;},
    observation=>{observation.requestBinding.request.subject='Different request';},
    observation=>{observation.requestBinding.request.description='Different scope';},
    observation=>{observation.requestBinding.request.fields={role:'administrator'};},
    observation=>{delete observation.requestBinding;},
  ]) {
    const fixture=await fresh(); const current=await processApproval(fixture.id);
    const observation=records.get(current.provider_instance_id); observation.state='APPROVED'; change(observation);
    assert.equal((await processApproval(fixture.id)).state,'BLOCKED');
    assert.equal((await row(fixture.id)).last_error,'PROVIDER_BINDING_MISMATCH');
    assert.equal((await row(fixture.id)).last_verified_at,null,'mismatched remote scope cannot retain approval evidence');
  }

  const tamperedAfterApproval=await fresh(); const tamperedRow=await processApproval(tamperedAfterApproval.id);
  records.get(tamperedRow.provider_instance_id).state='APPROVED';
  assert.equal((await processApproval(tamperedAfterApproval.id)).state,'APPROVED');
  records.get(tamperedRow.provider_instance_id).requestBinding.request.fields={scope:'changed-remotely'};
  assert.equal((await processApproval(tamperedAfterApproval.id)).state,'BLOCKED','remote scope changes invalidate prior approval');
  assert.equal((await row(tamperedAfterApproval.id)).last_verified_at,null);

  const unavailableAfterApproval=await fresh(); const unavailableRow=await processApproval(unavailableAfterApproval.id);
  records.get(unavailableRow.provider_instance_id).state='APPROVED';
  assert.equal((await processApproval(unavailableAfterApproval.id)).state,'APPROVED');
  assert.equal((await processApproval(unavailableAfterApproval.id,{...provider,inspect:async()=>{throw new Error('provider-secret-sentinel');}})).state,'PENDING');
  assert.equal((await row(unavailableAfterApproval.id)).last_verified_at,null,'failed lookup clears approval evidence');
  await retire(unavailableAfterApproval.id);

  const callbackRace=await fresh(); const callbackRow=await processApproval(callbackRace.id);
  records.get(callbackRow.provider_instance_id).state='APPROVED';
  assert.equal((await processApproval(callbackRace.id)).state,'APPROVED');
  const firstHint=randomUUID();
  assert.equal(await hint(callbackRace.id,firstHint),true);
  assert.equal((await row(callbackRace.id)).state,'PENDING','new hint invalidates approval until reinspection');
  assert.equal((await row(callbackRace.id)).last_verified_at,null);
  assert.equal(await hint(callbackRace.id,firstHint),false,'duplicate hint does not mutate the ledger');
  assert.equal((await processApproval(callbackRace.id)).state,'APPROVED');
  const verifiedBeforeDuplicate=(await row(callbackRace.id)).last_verified_at.getTime();
  assert.equal(await hint(callbackRace.id,firstHint),false);
  assert.equal((await row(callbackRace.id)).state,'APPROVED','replayed hint cannot clear freshly reverified approval');
  assert.equal((await row(callbackRace.id)).last_verified_at.getTime(),verifiedBeforeDuplicate);
  let releaseInspection; let signalInspection;
  const inspectionStarted=new Promise(resolve=>{signalInspection=resolve;});
  const heldInspection=new Promise(resolve=>{releaseInspection=resolve;});
  const staleInspection=processApproval(callbackRace.id,{...provider,inspect:async instanceId=>{
    const observed=await provider.inspect(instanceId);signalInspection();await heldInspection;return observed;
  }});
  await inspectionStarted;
  try {
    records.get(callbackRow.provider_instance_id).state='WITHDRAWN';
    await hint(callbackRace.id);
    assert.equal((await row(callbackRace.id)).lease_token,null,'hint fences the old inspection lease');
    assert.equal((await row(callbackRace.id)).last_verified_at,null);
  } finally {releaseInspection();}
  assert.equal((await staleInspection).state,'PENDING','stale approved reply cannot overwrite a newer callback hint');
  assert.equal((await processApproval(callbackRace.id)).state,'WITHDRAWN','fresh authoritative query observes withdrawal');

  const regressed=await fresh(); const regressionRow=await processApproval(regressed.id);
  records.get(regressionRow.provider_instance_id).state='APPROVED';
  assert.equal((await processApproval(regressed.id)).state,'APPROVED');
  await hint(regressed.id);
  records.get(regressionRow.provider_instance_id).state='PENDING';
  assert.equal((await processApproval(regressed.id)).state,'BLOCKED','hint does not erase historical approval regression protection');
  assert.equal((await row(regressed.id)).last_error,'PROVIDER_STATE_REGRESSION');

  const concurrency=await fresh(); let releaseCreate; let signalStarted;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  const waiting=new Promise(resolve=>{releaseCreate=resolve;});
  const beforeCreates=creates;
  const first=processApproval(concurrency.id,{...provider,create:async input=>{signalStarted();await waiting;return provider.create(input);}});
  await started;
  try {assert.equal(await processNextRequestApproval(db,provider),false,'second worker cannot dispatch a leased intent');}
  finally {releaseCreate();}
  assert.equal((await first).state,'PENDING');
  assert.equal(creates,beforeCreates+1);
  await retire(concurrency.id);

  const lostReply=await fresh(); let releaseReply; let signalAccepted;
  const accepted=new Promise(resolve=>{signalAccepted=resolve;});
  const heldReply=new Promise(resolve=>{releaseReply=resolve;});
  const late=processApproval(lostReply.id,{...provider,create:async input=>{
    const result=await provider.create(input);signalAccepted();await heldReply;return result;
  }});
  await accepted;
  await db.query("UPDATE request_approvals SET lease_until=now()-interval '1 second',next_at=now() WHERE id=$1",[lostReply.id]);
  try {
    assert.equal((await processApproval(lostReply.id)).state,'PENDING','new worker recovers accepted instance after lease loss');
  } finally {releaseReply();}
  assert.equal((await late).state,'PENDING','late former lease cannot overwrite reconciled state');
  assert.equal((await row(lostReply.id)).creation_attempts,1);
  await retire(lostReply.id);

  const uncertain=await fresh(); const beforeUncertain=creates;
  const ambiguous={...provider,create:async input=>{await provider.create(input);throw new Error('provider-secret-sentinel');}};
  assert.equal((await processApproval(uncertain.id,ambiguous)).state,'CREATE_UNCERTAIN');
  assert.equal((await processApproval(uncertain.id)).state,'PENDING','authoritative reference recovery binds existing instance');
  assert.equal(creates,beforeUncertain+1,'ambiguous outcome never repeats create');
  records.get((await row(uncertain.id)).provider_instance_id).state='REJECTED';
  assert.equal((await processApproval(uncertain.id)).state,'REJECTED');

  const crashed=await fresh();
  await db.query(`UPDATE request_approvals SET state='CREATING',creation_attempts=1,lease_token=$2,
    lease_until=now()-interval '1 second',next_at=now() WHERE id=$1`,[crashed.id,randomUUID()]);
  const beforeCrash=creates;
  assert.equal((await processApproval(crashed.id,{...provider,recoverCreated:undefined})).state,'CREATE_UNCERTAIN');
  assert.equal(creates,beforeCrash,'lost lease is uncertain, not queued again');
  await db.query('UPDATE request_approvals SET attempts=9 WHERE id=$1',[crashed.id]);
  assert.equal((await processApproval(crashed.id,{...provider,recoverCreated:undefined})).state,'BLOCKED','unresolved creation needs operator reconciliation');
  assert.equal((await row(crashed.id)).creation_attempts,1);
  await assert.rejects(db.query('UPDATE request_approvals SET creation_attempts=0 WHERE id=$1',[crashed.id]),/REQUEST_APPROVAL_IMMUTABLE/);

  const timedOut=await fresh();
  assert.equal((await processApproval(timedOut.id,{...provider,create:async()=>new Promise(()=>{})})).state,'CREATE_UNCERTAIN','bounded provider call times out without re-creating');
  await db.query('UPDATE request_approvals SET attempts=9 WHERE id=$1',[timedOut.id]);
  assert.equal((await processApproval(timedOut.id,{...provider,recoverCreated:undefined})).state,'BLOCKED');

  const departure=await fresh();
  assert.equal((await processApproval(departure.id,{...provider,create:async input=>{
    const result=await provider.create(input);
    await db.query('UPDATE employees SET active=false WHERE id=$1',[employee('requester')]);
    return result;
  }})).state,'BLOCKED');
  assert.ok((await row(departure.id)).provider_instance_id,'retain created instance for operational cleanup even if applicant leaves');
  await db.query('UPDATE employees SET active=true WHERE id=$1',[employee('requester')]);

  const managerChanged=await fresh(); await processApproval(managerChanged.id);
  await db.query("UPDATE request_manager_mappings SET source_reference='CI-CHANGED' WHERE employee_id=$1",[employee('requester')]);
  await maintainRequestApprovals(db);
  assert.equal((await row(managerChanged.id)).state,'BLOCKED');
  await mapping();
  const changedScope=await fresh(); const changedScopeRow=await processApproval(changedScope.id);
  records.get(changedScopeRow.provider_instance_id).state='APPROVED';
  await db.query(`UPDATE tickets SET fields='{"role":"changed-after-submission"}' WHERE id=$1`,[changedScope.input.ticketId]);
  await maintainRequestApprovals(db);
  assert.equal((await row(changedScope.id)).last_error,'APPROVAL_REQUEST_CHANGED','changed scope cannot reuse approval');
  const identityChanged=await fresh(); await processApproval(identityChanged.id);
  await db.query("UPDATE identity_links SET ding_user_id='CI-DING-REASSIGNED' WHERE corp_id=$1 AND employee_id=$2",[corp,employee('owner')]);
  await maintainRequestApprovals(db);
  assert.equal((await row(identityChanged.id)).last_error,'APPROVAL_IDENTITY_CHANGED');
  await db.query("UPDATE identity_links SET ding_user_id='CI-DING-owner' WHERE corp_id=$1 AND employee_id=$2",[corp,employee('owner')]);

  const cancelled=await fresh(); await processApproval(cancelled.id);
  assert.equal((await processApproval(cancelled.id,{...provider,inspect:async instanceId=>{
    const observed=await provider.inspect(instanceId); observed.state='APPROVED';
    await db.query("UPDATE tickets SET status='CANCELLED' WHERE id=$1",[cancelled.input.ticketId]); return observed;
  }})).state,'BLOCKED','cancel-versus-approve race never releases fulfillment');

  const expiration=await enqueue(await draft(),new Date(Date.now()+1500));
  const deadline=Date.now()+10000;
  let expirationState;
  // Observe the database-driven transition instead of assuming both clocks reach the deadline together.
  do {
    await maintainRequestApprovals(db);
    expirationState=(await row(expiration.id)).state;
    if (expirationState === 'EXPIRED') break;
    await delay(25);
  } while (Date.now()<deadline);
  assert.equal(expirationState,'EXPIRED','queued approval must expire within the bounded maintenance window');
  assert.equal((await row(expiration.id)).creation_attempts,0);
  const fulfillment=await fresh(); const fulfillmentRow=await processApproval(fulfillment.id);
  await assert.rejects(prepareRequestFulfillment(db,provider,fulfillment.id,employee('verifier')),
    /FULFILLMENT_APPROVAL_UNAVAILABLE/,'pending OA cannot create a delivery task');
  records.get(fulfillmentRow.provider_instance_id).state='APPROVED';
  await processApproval(fulfillment.id);
  await assert.rejects(prepareRequestFulfillment(db,provider,fulfillment.id,employee('requester')),
    /FULFILLMENT_OPERATOR_DENIED/);
  const taskId=await prepareRequestFulfillment(db,provider,fulfillment.id,employee('verifier'));
  assert.equal(await prepareRequestFulfillment(db,provider,fulfillment.id,employee('verifier')),taskId);
  await assert.rejects(reviewRequestDelivery(db,fulfillment.id,employee('reviewer'),'CHG-REVIEW-099'),
    /FULFILLMENT_REVIEW_UNAVAILABLE/,'a prepared task is not a delivered grant');
  await assert.rejects(recordRequestDelivery(db,provider,fulfillment.id,employee('manager'),'CHG-100'),/FULFILLMENT_NOT_READY/);
  await assert.rejects(recordRequestDelivery(db,provider,fulfillment.id,employee('verifier'),'invalid secret value'),/FULFILLMENT_EVIDENCE_REQUIRED/);
  await recordRequestDelivery(db,provider,fulfillment.id,employee('verifier'),'CHG-100');
  const delivered=(await db.query('SELECT * FROM request_fulfillments WHERE id=$1',[taskId])).rows[0];
  assert.equal(delivered.state,'DELIVERED');
  assert.ok(delivered.access_expires_at > delivered.delivered_at);
  await assert.rejects(recordRequestDelivery(db,provider,fulfillment.id,employee('verifier'),'CHG-101'),/FULFILLMENT_NOT_READY/);
  await assert.rejects(reviewRequestDelivery(db,fulfillment.id,employee('verifier'),'CHG-REVIEW-100'),/FULFILLMENT_OPERATOR_DENIED/);
  await assert.rejects(reviewRequestDelivery(db,fulfillment.id,employee('requester'),'CHG-REVIEW-100'),/FULFILLMENT_OPERATOR_DENIED/);
  await assert.rejects(reviewRequestDelivery(db,fulfillment.id,employee('reviewer'),'bad evidence'),/FULFILLMENT_EVIDENCE_REQUIRED/);
  await assert.rejects(reviewRequestDelivery(db,fulfillment.id,employee('reviewer'),'CHG-100'),/FULFILLMENT_EVIDENCE_REUSED/);
  await db.query('UPDATE employees SET active=false WHERE id=$1',[employee('reviewer')]);
  await assert.rejects(reviewRequestDelivery(db,fulfillment.id,employee('reviewer'),'CHG-REVIEW-100'),/FULFILLMENT_OPERATOR_DENIED/);
  await db.query('UPDATE employees SET active=true WHERE id=$1',[employee('reviewer')]);
  await reviewRequestDelivery(db,fulfillment.id,employee('reviewer'),'CHG-REVIEW-100');
  assert.equal((await db.query('SELECT reviewed_by FROM request_fulfillments WHERE id=$1',[taskId])).rows[0].reviewed_by,
    employee('reviewer'));
  await assert.rejects(reviewRequestDelivery(db,fulfillment.id,employee('reviewer'),'CHG-REVIEW-101'),/FULFILLMENT_REVIEW_UNAVAILABLE/);
  await assert.rejects(db.query('UPDATE request_fulfillments SET reviewed_by=$2 WHERE id=$1',[taskId,employee('verifier')]),
    /REQUEST_FULFILLMENT_IMMUTABLE/);
  assert.equal((await db.query("SELECT count(*) FROM request_fulfillment_events WHERE fulfillment_id=$1 AND action='DELIVERY_REVIEWED'",[taskId])).rows[0].count,'1');
  await assert.rejects(db.query('DELETE FROM request_fulfillments WHERE id=$1',[taskId]),/REQUEST_FULFILLMENT_IMMUTABLE/);
  await assert.rejects(db.query("UPDATE request_fulfillment_events SET evidence_reference='CHG-999' WHERE fulfillment_id=$1",[taskId]),
    /REQUEST_CATALOG_VERSION_IMMUTABLE/);
  await db.query("UPDATE request_fulfillments SET access_expires_at=now()-interval '1 minute' WHERE id=$1",[taskId]).then(
    ()=>assert.fail('immutable access term changed'),()=>{});
  await hint(fulfillment.id);
  await maintainRequestFulfillments(db);
  assert.equal((await db.query('SELECT state FROM request_fulfillments WHERE id=$1',[taskId])).rows[0].state,'REVOKE_DUE',
    'a callback invalidates earlier approval evidence and requires manual revocation');
  await assert.rejects(recordRequestRevocation(db,fulfillment.id,employee('verifier'),'CHG-100'),/FULFILLMENT_EVIDENCE_REUSED/);
  await assert.rejects(recordRequestRevocation(db,fulfillment.id,employee('verifier'),'CHG-REVIEW-100'),/FULFILLMENT_EVIDENCE_REUSED/);
  await recordRequestRevocation(db,fulfillment.id,employee('verifier'),'CHG-102');
  assert.equal((await db.query('SELECT state FROM request_fulfillments WHERE id=$1',[taskId])).rows[0].state,'REVOKED');

  const withdrawnBeforeGrant=await fresh(); const withdrawnRow=await processApproval(withdrawnBeforeGrant.id);
  records.get(withdrawnRow.provider_instance_id).state='APPROVED';
  await processApproval(withdrawnBeforeGrant.id);
  const readyId=await prepareRequestFulfillment(db,provider,withdrawnBeforeGrant.id,employee('verifier'));
  records.get(withdrawnRow.provider_instance_id).state='WITHDRAWN';
  await assert.rejects(recordRequestDelivery(db,provider,withdrawnBeforeGrant.id,employee('verifier'),'CHG-103'),
    /FULFILLMENT_PROVIDER_NOT_APPROVED/,'provider withdrawal immediately before delivery blocks the receipt');
  await hint(withdrawnBeforeGrant.id);
  await maintainRequestFulfillments(db);
  assert.equal((await db.query('SELECT state FROM request_fulfillments WHERE id=$1',[readyId])).rows[0].state,'BLOCKED');

  const raced=await fresh(); const racedRow=await processApproval(raced.id);
  records.get(racedRow.provider_instance_id).state='APPROVED';
  await processApproval(raced.id);
  await prepareRequestFulfillment(db,provider,raced.id,employee('verifier'));
  await assert.rejects(recordRequestDelivery(db,{...provider,inspect:async(instanceId,signal)=>{
    const observed=await provider.inspect(instanceId,signal);
    await hint(raced.id);
    return observed;
  }},raced.id,employee('verifier'),'CHG-106'),/FULFILLMENT_APPROVAL_UNAVAILABLE/,
  'callback arriving after remote inspection fences the stale reply');
  await maintainRequestFulfillments(db);
  assert.equal((await db.query('SELECT state FROM request_fulfillments WHERE approval_id=$1',[raced.id])).rows[0].state,'BLOCKED');

  const deactivated=await fresh(); const deactivatedRow=await processApproval(deactivated.id);
  records.get(deactivatedRow.provider_instance_id).state='APPROVED';
  await processApproval(deactivated.id);
  const deactivatedTask=await prepareRequestFulfillment(db,provider,deactivated.id,employee('verifier'));
  await db.query('UPDATE employees SET active=false WHERE id=$1',[employee('requester')]);
  await maintainRequestFulfillments(db);
  assert.equal((await db.query('SELECT state FROM request_fulfillments WHERE id=$1',[deactivatedTask])).rows[0].state,'BLOCKED');
  await db.query('UPDATE employees SET active=true WHERE id=$1',[employee('requester')]);

  const cancelledAfterGrant=await fresh(); const cancelledRow=await processApproval(cancelledAfterGrant.id);
  records.get(cancelledRow.provider_instance_id).state='APPROVED';
  await processApproval(cancelledAfterGrant.id);
  const cancelledTask=await prepareRequestFulfillment(db,provider,cancelledAfterGrant.id,employee('verifier'));
  await recordRequestDelivery(db,provider,cancelledAfterGrant.id,employee('verifier'),'CHG-104');
  await db.query("UPDATE tickets SET status='CANCELLED' WHERE id=$1",[cancelledAfterGrant.input.ticketId]);
  await maintainRequestFulfillments(db);
  assert.equal((await db.query('SELECT state FROM request_fulfillments WHERE id=$1',[cancelledTask])).rows[0].state,'REVOKE_DUE');
  await recordRequestRevocation(db,cancelledAfterGrant.id,employee('verifier'),'CHG-105');
  const healthy=await fresh(); const healthyRow=await processApproval(healthy.id);
  records.get(healthyRow.provider_instance_id).state='APPROVED';
  await processApproval(healthy.id);
  const healthyTask=await prepareRequestFulfillment(db,provider,healthy.id,employee('verifier'));
  await db.query("UPDATE request_fulfillments SET updated_at=now()-interval '1 day' WHERE id=$1",[healthyTask]);
  await maintainRequestFulfillments(db);
  const checked=(await db.query('SELECT state,updated_at FROM request_fulfillments WHERE id=$1',[healthyTask])).rows[0];
  assert.equal(checked.state,'READY');
  assert.ok(checked.updated_at > new Date(Date.now()-60_000),'healthy task advances beyond the oldest batch');

  const deliveryDomain=`delivery-domain-${randomUUID()}`,deliveryPosition=`delivery-position-${randomUUID()}`;
  const deliveryEmployee=employee('reviewer');
  const deliveryRouting={version:1,domainId:deliveryDomain,systemId:null,primaryPositionId:deliveryPosition,
    positions:[{id:deliveryPosition,groupId:'oa-ci-group'}]};
  async function configureDelivery(change,client) {
    if(!client)return transaction(async writer=>{
      await writer.query('SELECT pg_advisory_xact_lock(71820512)');
      await configureDelivery(change,writer);
    });
    const current=(await client.query(`SELECT v.version,v.config FROM service_structure_current c
      JOIN service_structure_versions v ON v.version=c.version WHERE c.id FOR UPDATE OF c`)).rows[0];
    const config=structuredClone(current.config);change(config);
    await client.query('INSERT INTO service_structure_versions(version,config) VALUES ($1,$2)',[current.version+1,JSON.stringify(config)]);
    await client.query('UPDATE service_structure_current SET version=$1 WHERE id',[current.version+1]);
  }
  await configureDelivery(config=>{
    config.domains.push({id:deliveryDomain,name:'CI delivery responsibility',enabled:true});
    config.positions.push({id:deliveryPosition,name:'CI delivery position',domainId:deliveryDomain,groupId:'oa-ci-group',enabled:true});
    for(const role of roles)config.appointments.push({id:randomUUID(),positionId:deliveryPosition,employeeId:employee(role),duty:'PRIMARY',
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),enabled:true});
  });
  for(const role of ['requester','manager','owner'])await db.query(`INSERT INTO group_memberships(employee_id,group_id)
    VALUES ($1,'oa-ci-group')`,[employee(role)]);
  await db.query(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,requested_by,reviewed_by,reason)
    VALUES ($1,$2,'GROUP_LEAD','oa-ci-group',now()-interval '1 minute',now()+interval '1 day','ACTIVE',$3,$4,'CI-only delivery separation')`,
    [randomUUID(),deliveryEmployee,employee('requester'),employee('manager')]);
  const appointment=config=>config.appointments.find(item=>item.positionId===deliveryPosition&&item.employeeId===deliveryEmployee);
  const appointDelivery=enabled=>configureDelivery(config=>{appointment(config).enabled=enabled;});
  async function approvedDelivery(expiresAt=new Date(Date.now()+3600000)) {
    const item=await enqueue(await draft(db,deliveryRouting),expiresAt);
    const pending=await processApproval(item.id);records.get(pending.provider_instance_id).state='APPROVED';
    assert.equal((await processApproval(item.id)).state,'APPROVED');return item;
  }
  const noDeliveryTask=async item=>assert.equal((await db.query('SELECT count(*) FROM request_fulfillments WHERE approval_id=$1',[item.id])).rows[0].count,'0');
  async function untouchedDelivery(id) {
    const task=(await db.query('SELECT state,delivered_at,access_expires_at,version FROM request_fulfillments WHERE id=$1',[id])).rows[0];
    assert.deepEqual(task,{state:'READY',delivered_at:null,access_expires_at:null,version:1});
    assert.equal((await db.query('SELECT count(*) FROM request_fulfillment_events WHERE fulfillment_id=$1',[id])).rows[0].count,'1');
  }
  async function until(check) {
    const deadline=Date.now()+10000;
    do {if(await check())return;await delay(20);}while(Date.now()<deadline);
    assert.fail('delivery authorization wait did not reach its bounded condition');
  }
  async function behindAuthorizationLock(item,action,during=async()=>{}) {
    const publisher=await db.connect();let pending,committed=false;
    try {
      await publisher.query('BEGIN');await publisher.query('SELECT pg_advisory_xact_lock(71820512)');
      await publisher.query('SELECT id FROM request_approvals WHERE id=$1 FOR UPDATE',[item.id]);
      pending=action().then(()=>null,error=>error);
      await until(async()=>(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND l.classid=0 AND l.objid=71820512 AND NOT l.granted AND a.application_name='itsm-oa-ci') AS waiting`)).rows[0].waiting);
      await during(publisher);
      const releasedAt=(await publisher.query('SELECT clock_timestamp() AS clock')).rows[0].clock;
      await publisher.query('COMMIT');committed=true;
      return {error:await pending,releasedAt};
    } finally {if(!committed)await publisher.query('ROLLBACK');publisher.release();if(pending)await pending;}
  }

  const scoped=await approvedDelivery();
  for(const role of ['requester','manager','owner']){
    await assert.rejects(prepareRequestFulfillment(db,provider,scoped.id,employee(role)),/FULFILLMENT_OPERATOR_DENIED/,
      'a current appointment and group membership do not bypass applicant/approver separation');
    await noDeliveryTask(scoped);
  }
  await assert.rejects(db.query("UPDATE support_groups SET enabled=false WHERE id='oa-ci-group'"),/SUPPORT_GROUP_DEPENDENCIES/);
  assert.equal((await db.query('SELECT request_delivery_operator_eligible($1,$2) AS eligible',[scoped.id,deliveryEmployee])).rows[0].eligible,true,
    'dependency-protected retirement must not partially disable a delivery group');
  for(const change of [
    config=>{appointment(config).enabled=false;},
    config=>{appointment(config).validTo=new Date(Date.now()-1000).toISOString();},
    config=>{appointment(config).validFrom=new Date(Date.now()+60000).toISOString();},
    config=>{config.positions.find(item=>item.id===deliveryPosition).enabled=false;appointment(config).enabled=false;},
    config=>{config.domains.find(item=>item.id===deliveryDomain).enabled=false;
      config.positions.find(item=>item.id===deliveryPosition).enabled=false;
      config.appointments.filter(item=>item.positionId===deliveryPosition).forEach(item=>{item.enabled=false;});},
  ]) {
    await configureDelivery(change);
    await assert.rejects(prepareRequestFulfillment(db,provider,scoped.id,deliveryEmployee),/FULFILLMENT_OPERATOR_DENIED/,
      'even a current group lead needs the configured, currently valid delivery appointment');
    await noDeliveryTask(scoped);
    await configureDelivery(config=>{
      config.domains.find(item=>item.id===deliveryDomain).enabled=true;
      config.positions.find(item=>item.id===deliveryPosition).enabled=true;
      config.appointments.filter(item=>item.positionId===deliveryPosition).forEach(item=>{item.enabled=true;
        item.validFrom=new Date(Date.now()-60000).toISOString();item.validTo=new Date(Date.now()+86400000).toISOString();});
    });
  }
  await db.query('DELETE FROM group_memberships WHERE employee_id=$1 AND group_id=\'oa-ci-group\'',[deliveryEmployee]);
  await assert.rejects(prepareRequestFulfillment(db,provider,scoped.id,deliveryEmployee),/FULFILLMENT_OPERATOR_DENIED/);
  await noDeliveryTask(scoped);
  await db.query("INSERT INTO group_memberships(employee_id,group_id) VALUES ($1,'oa-ci-group')",[deliveryEmployee]);
  await db.query('UPDATE employees SET active=false WHERE id=$1',[deliveryEmployee]);
  await assert.rejects(prepareRequestFulfillment(db,provider,scoped.id,deliveryEmployee),/FULFILLMENT_OPERATOR_DENIED/);
  await noDeliveryTask(scoped);await db.query('UPDATE employees SET active=true WHERE id=$1',[deliveryEmployee]);
  await assert.rejects(prepareRequestFulfillment(db,{...provider,inspect:async instanceId=>{
    const observed=await provider.inspect(instanceId);await appointDelivery(false);return observed;
  }},scoped.id,deliveryEmployee),/FULFILLMENT_OPERATOR_DENIED/,'preparation rechecks appointments after provider inspection');
  await noDeliveryTask(scoped);await appointDelivery(true);

  const scopedTask=await prepareRequestFulfillment(db,provider,scoped.id,deliveryEmployee);
  await assert.rejects(recordRequestDelivery(db,{...provider,inspect:async instanceId=>{
    const observed=await provider.inspect(instanceId);await appointDelivery(false);return observed;
  }},scoped.id,deliveryEmployee,'CHG-SCOPED-DENIED'),/FULFILLMENT_OPERATOR_DENIED/);
  await untouchedDelivery(scopedTask);await appointDelivery(true);
  const revokedWhileWaiting=await behindAuthorizationLock(scoped,
    ()=>recordRequestDelivery(db,provider,scoped.id,deliveryEmployee,'CHG-SCOPED-RACE'),
    publisher=>configureDelivery(config=>{appointment(config).enabled=false;},publisher));
  assert.match(revokedWhileWaiting.error?.message??'',/FULFILLMENT_OPERATOR_DENIED/,
    'delivery must wait before locking the approval and observe the committed appointment withdrawal');
  await untouchedDelivery(scopedTask);await appointDelivery(true);
  const successfulWait=await behindAuthorizationLock(scoped,
    ()=>recordRequestDelivery(db,provider,scoped.id,deliveryEmployee,'CHG-SCOPED-DELIVERED'));
  assert.equal(successfulWait.error,null);
  const scopedDelivered=(await db.query('SELECT delivered_at FROM request_fulfillments WHERE id=$1',[scopedTask])).rows[0];
  assert.ok(scopedDelivered.delivered_at>=successfulWait.releasedAt,'actual delivery time is sampled after lock waits, not at BEGIN');
  await appointDelivery(false);await db.query('UPDATE employees SET active=false WHERE id=$1',[deliveryEmployee]);
  await maintainRequestFulfillments(db);
  assert.equal((await db.query('SELECT state FROM request_fulfillments WHERE id=$1',[scopedTask])).rows[0].state,'DELIVERED',
    'operator departure alone does not invalidate already granted recipient access');
  await db.query('UPDATE employees SET active=true WHERE id=$1',[deliveryEmployee]);await appointDelivery(true);

  const lostAppointment=await approvedDelivery(),lostTask=await prepareRequestFulfillment(db,provider,lostAppointment.id,deliveryEmployee);
  await appointDelivery(false);await maintainRequestFulfillments(db);
  const blockedTask=(await db.query('SELECT state,reason_code,delivered_at,version FROM request_fulfillments WHERE id=$1',[lostTask])).rows[0];
  assert.deepEqual(blockedTask,{state:'BLOCKED',reason_code:'DELIVERY_OPERATOR_UNAVAILABLE',delivered_at:null,version:2});
  assert.equal((await db.query(`SELECT count(*) FROM request_fulfillment_events WHERE fulfillment_id=$1
    AND action='TASK_BLOCKED' AND reason_code='DELIVERY_OPERATOR_UNAVAILABLE'`,[lostTask])).rows[0].count,'1');
  await appointDelivery(true);
  await assert.rejects(prepareRequestFulfillment(db,provider,lostAppointment.id,deliveryEmployee),/FULFILLMENT_ALREADY_EXISTS/,
    'restoring an appointment does not silently resurrect a blocked delivery task');

  const shortTerm=await approvedDelivery(new Date(Date.now()+2500));
  const shortTask=await prepareRequestFulfillment(db,provider,shortTerm.id,deliveryEmployee);
  const expiredWhileWaiting=await behindAuthorizationLock(shortTerm,
    ()=>recordRequestDelivery(db,provider,shortTerm.id,deliveryEmployee,'CHG-EXPIRED-WAIT'),async()=>{
      await until(async()=>(await db.query('SELECT clock_timestamp()>=expires_at AS expired FROM request_approvals WHERE id=$1',[shortTerm.id])).rows[0].expired);
    });
  assert.match(expiredWhileWaiting.error?.message??'',/FULFILLMENT_NOT_READY/,'lock waits cannot extend a first-delivery window');
  await untouchedDelivery(shortTask);
  await maintainRequestFulfillments(db);
  assert.equal((await db.query('SELECT reason_code FROM request_fulfillments WHERE id=$1',[shortTask])).rows[0].reason_code,'DELIVERY_WINDOW_EXPIRED');
  const queuedExpiry=await approvedDelivery(),queuedTask=await prepareRequestFulfillment(db,provider,queuedExpiry.id,deliveryEmployee);
  const expiryCommand=(await db.query(`INSERT INTO request_delivery_commands(approval_id,actor_id,request_key,operation,
    expected_version,evidence_reference,request_hash,expires_at) VALUES($1,$2,$3,'DELIVER',1,'CHG-QUEUED-EXPIRED',repeat('b',64),
    clock_timestamp()+interval '2500 milliseconds') RETURNING id`,[queuedExpiry.id,deliveryEmployee,randomUUID()])).rows[0].id;
  const approvalHolder=await db.connect();let queuedWork,holderCommitted=false;
  try{
    await approvalHolder.query('BEGIN');await approvalHolder.query('SELECT id FROM request_approvals WHERE id=$1 FOR UPDATE',[queuedExpiry.id]);
    queuedWork=processNextRequestDelivery(db,provider);
    await until(async()=>(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='itsm-oa-ci'
      AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM request_approvals WHERE id=%') AS waiting`)).rows[0].waiting);
    await until(async()=>(await db.query('SELECT expires_at<=clock_timestamp() AS expired FROM request_delivery_commands WHERE id=$1',[expiryCommand])).rows[0].expired);
    await approvalHolder.query('COMMIT');holderCommitted=true;assert.equal(await queuedWork,true);
  }finally{if(!holderCommitted)await approvalHolder.query('ROLLBACK');approvalHolder.release();if(queuedWork)await queuedWork;}
  assert.deepEqual((await db.query('SELECT state,error_code,result FROM request_delivery_commands WHERE id=$1',[expiryCommand])).rows[0],
    {state:'REJECTED',error_code:'REQUEST_DELIVERY_COMMAND_EXPIRED',result:null});
  await untouchedDelivery(queuedTask);
  assert.equal((await db.query("SELECT count(*) FROM request_approval_events WHERE strpos(row_to_json(request_approval_events)::text,'provider-secret-sentinel')>0")).rows[0].count,'0');
  assert.equal((await db.query("SELECT count(*) FROM request_approvals WHERE strpos(row_to_json(request_approvals)::text,'provider-secret-sentinel')>0")).rows[0].count,'0');
  console.log('OA and manual fulfillment core verified: immutable snapshots, callback fencing, current delivery appointments, post-lock deadlines, operator withdrawal races and recipient revocation obligations; real DingTalk and REQ routes remain gated');
} finally {await db.end();}
