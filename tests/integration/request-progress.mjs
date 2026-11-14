import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequestProgressFixture } from '../support/request-progress.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');

const base='http://127.0.0.1:8088/api/v1';
async function get(id,user) {
  const response=await fetch(`${base}/tickets/${id}`,{headers:{'X-Dev-User':user}});
  return {status:response.status,data:await response.json()};
}
const cases=[{},...['QUEUED','CREATING','CREATE_UNCERTAIN','PENDING','APPROVED','REJECTED','WITHDRAWN','EXPIRED','BLOCKED']
  .map(approvalState=>({approvalState})),...['READY','DELIVERED','REVOKE_DUE','REVOKED','BLOCKED']
  .map(fulfillmentState=>({approvalState:fulfillmentState==='BLOCKED'?'BLOCKED':'APPROVED',fulfillmentState}))];
for(const state of cases){
  const fixture=await createRequestProgressFixture(state);
  const applicant=await get(fixture.id,'employee-1');
  assert.equal(applicant.status,200,JSON.stringify(applicant));
  const expected=structuredClone(fixture.progress);
  for(const part of ['approval','fulfillment']){
    if(!expected[part])continue;
    const actual=applicant.data.requestProgress?.[part];
    assert.equal(typeof actual?.updatedAt,'string',`${part} update time must be public`);
    assert.ok(Number.isFinite(Date.parse(actual.updatedAt)),`${part} update time must be valid`);
    // Healthy background maintenance refreshes this timestamp without changing business facts.
    expected[part].updatedAt=actual.updatedAt;
  }
  assert.deepEqual(applicant.data.requestProgress,expected,`exact public projection for ${JSON.stringify(state)}`);
  assert.equal(JSON.stringify(applicant.data).includes(fixture.internalMarker),false,'OA identifiers, snapshot and failure details must remain private');
}
const {id:populatedId}=await createRequestProgressFixture({approvalState:'APPROVED',fulfillmentState:'READY'});

const hiddenFromEmployee=await get(populatedId,'employee-2');
assert.equal(hiddenFromEmployee.status,404,'unrelated employees must not retrieve the ticket or its progress');

const supportAgent=await get(populatedId,'agent-1');
assert.equal(supportAgent.status,200,JSON.stringify(supportAgent));
assert.equal(Object.hasOwn(supportAgent.data,'requestProgress'),false,'support access must not disclose requester-only progress');

const incidentResponse=await fetch(`${base}/tickets`,{method:'POST',headers:{
  'Content-Type':'application/json','X-Dev-User':'employee-1','Idempotency-Key':randomUUID(),
},body:JSON.stringify({contentClass:'GENERAL',serviceCode:'INC-BIZ',formVersion:1,subject:'Request progress boundary',
  description:'CI-only incident',impact:'INDIVIDUAL',urgency:'LOW',fields:{}})});
const incident=await incidentResponse.json();
assert.equal(incidentResponse.status,201,JSON.stringify(incident));
const incidentDetail=await get(incident.id,'employee-1');
assert.equal(incidentDetail.status,200,JSON.stringify(incidentDetail));
assert.equal(Object.hasOwn(incidentDetail.data,'requestProgress'),false,'INC details must not expose REQ progress');

console.log('REQ progress lifecycle projections, private-field exclusion, empty state, requester isolation and non-REQ boundary verified');
