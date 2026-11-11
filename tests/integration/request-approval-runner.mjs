import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { enqueueRequestApproval, maintainRequestApprovals, processNextRequestApproval, queueVerifiedApprovalHint } from './apps/worker/dist/request-approval.js';

if (process.env.ITSM_APPROVAL_CI !== 'true' || process.env.NODE_ENV === 'production') throw new Error('DISPOSABLE_APPROVAL_CI_ONLY');
const db = new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,max:6});
const corp = 'ci-approval-corp';
const roles = ['requester','manager','owner','verifier'];
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
async function draft(client=db) {
  const id=randomUUID();
  await client.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,
    form_version,subject,description,fields,impact,urgency,priority,status,catalog_snapshot)
    VALUES ($1,$2,$3,$3,'oa-ci-group','REQ-OA-CI','REQ',1,'Approval fixture','No real request','{}','INDIVIDUAL','LOW','P4','WAITING_APPROVAL',$4)`,
    [id,`OA-CI-${id}`,employee('requester'),JSON.stringify(catalog)]);
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
  await db.query('UPDATE request_approvals SET next_at=now() WHERE id=$1',[id]);
  assert.equal(await processNextRequestApproval(db,adapter),true);
  return row(id);
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
  await assert.rejects(transaction(async client=>{
    const ticketId=await draft(client);
    await enqueueRequestApproval(client,{ticketId,corpId:corp,expiresAt:new Date(Date.now()+3600000),requestedValidityDays:30});
    throw new Error('ROLLBACK_INTENT');
  }),/ROLLBACK_INTENT/);
  assert.equal(Number((await db.query('SELECT count(*) FROM tickets')).rows[0].count),beforeTickets);
  assert.equal(Number((await db.query('SELECT count(*) FROM request_approvals')).rows[0].count),0);

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
  const deadline=Date.now()+5000;
  while (Date.now()<expiration.input.expiresAt.getTime() && Date.now()<deadline) await delay(25);
  await maintainRequestApprovals(db);
  assert.equal((await row(expiration.id)).state,'EXPIRED');
  assert.equal((await row(expiration.id)).creation_attempts,0);
  assert.equal((await db.query("SELECT count(*) FROM request_approval_events WHERE strpos(row_to_json(request_approval_events)::text,'provider-secret-sentinel')>0")).rows[0].count,'0');
  assert.equal((await db.query("SELECT count(*) FROM request_approvals WHERE strpos(row_to_json(request_approvals)::text,'provider-secret-sentinel')>0")).rows[0].count,'0');
  console.log('OA lifecycle verified: immutable identity/policy snapshots, atomic intent, one create, lease recovery, callback fencing, authoritative binding, withdrawal, cancellation, expiry and inactive-person blocking; real DingTalk remains gated');
} finally {await db.end();}
