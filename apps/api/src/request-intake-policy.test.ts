import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestIntakePolicy } from './request-intake-policy.js';

const ready = {
  ENABLE_REQUEST_INTAKE: 'true', ENABLE_LIVE_OA_APPROVAL: 'true', ENABLE_MANUAL_REQUEST_DELIVERY: 'true',
  DINGTALK_CORP_ID: 'test-corp', DINGTALK_APP_KEY: 'test-key', DINGTALK_APP_SECRET: 'test-secret',
  REQUEST_APPROVAL_TIMEOUT_MINUTES: '120', REQUEST_INTAKE_CATALOG_VERSIONS: 'REQ-PERM@4,REQ-EQUIP@2',
};
test('intake is closed until the exact catalog revision and an explicit deadline have been accepted', () => {
  assert.equal(requestIntakePolicy({}, 'REQ-PERM', 4), null);
  assert.deepEqual(requestIntakePolicy(ready, 'REQ-PERM', 4), {corpId:'test-corp',approvalTimeoutMinutes:120});
  for (const [code, version] of [['REQ-PERM', 3], ['REQ-PERM', 5], ['REQ-OTHER', 4]] as const)
    assert.equal(requestIntakePolicy(ready, code, version), null);
  for (const key of Object.keys(ready)) assert.equal(requestIntakePolicy({...ready,[key]:''}, 'REQ-PERM', 4), null, key);
});
test('invalid allowlists and noncanonical deadlines never open the request boundary', () => {
  for (const value of ['REQ-PERM', 'REQ-PERM@*', 'REQ-PERM@04', 'REQ-PERM@4,', 'REQ-PERM@4,REQ-PERM@4'])
    assert.equal(requestIntakePolicy({...ready,REQUEST_INTAKE_CATALOG_VERSIONS:value}, 'REQ-PERM', 4), null);
  for (const value of ['0', '-1', '1.5', '1e3', ' 120', '525601'])
    assert.equal(requestIntakePolicy({...ready,REQUEST_APPROVAL_TIMEOUT_MINUTES:value}, 'REQ-PERM', 4), null);
  assert.equal(requestIntakePolicy({...ready,DINGTALK_APP_SECRET:'\n'}, 'REQ-PERM', 4), null);
});
