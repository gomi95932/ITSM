import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalStageAllowed,matches, type ApprovalObservation } from './request-approval.js';

test('approval provenance permits processing and closed grants but never cancelled or rejected requests',()=>{
  assert.equal(approvalStageAllowed('WAITING_APPROVAL',false),true);
  for(const status of ['IN_PROGRESS','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION','CLOSED']){
    assert.equal(approvalStageAllowed(status,false),false,status);
    assert.equal(approvalStageAllowed(status,true),true,status);
  }
  for(const status of ['QUEUED','NEW','CANCELLED','REJECTED',undefined]){
    assert.equal(approvalStageAllowed(status,false),false);
    assert.equal(approvalStageAllowed(status,true),false);
  }
});

const row: Parameters<typeof matches>[0] = {
  id: 'approval-1',
  ticket_id: 'ticket-1',
  corp_id: 'corp-1',
  snapshot: {
    serviceCode: 'AI-KEY',
    formVersion: 3,
    templateId: 'template-1',
    requestedValidityDays: 30,
    applicant: { employeeId: 'employee-1', dingUserId: 'ding-1' },
    approvers: [{ employeeId: 'employee-2', dingUserId: 'ding-2', role: 'MANAGER' }],
    catalog: {},
    request: { subject: '申请 AI Key', description: '用于开发', fields: { model: 'model-a' } },
  },
  expires_at: new Date('2026-12-01T00:00:00Z'),
  state: 'PENDING',
  provider_instance_id: 'instance-1',
  attempts: 1,
  lease_token: null,
  last_error: null,
  clock: new Date('2026-11-13T00:00:00Z'),
};

function observation(): ApprovalObservation {
  return {
    instanceId: 'instance-1',
    corpId: 'corp-1',
    templateId: 'template-1',
    applicantDingUserId: 'ding-1',
    approverDingUserIds: ['ding-2'],
    state: 'APPROVED',
    requestBinding: {
      reference: 'approval-1',
      serviceCode: 'AI-KEY',
      formVersion: 3,
      requestedValidityDays: 30,
      request: { subject: '申请 AI Key', description: '用于开发', fields: { model: 'model-a' } },
    },
  };
}

test('accepts an authoritative approval with matching bindings regardless of object key order', () => {
  const observed = observation();
  observed.requestBinding.request.fields = { model: 'model-a' };
  observed.requestBinding.request = {
    fields: { model: 'model-a' },
    description: '用于开发',
    subject: '申请 AI Key',
  };

  assert.equal(matches(row, observed), true);
});

test('rejects approval observations that point to a different identity, template, or instance', () => {
  for (const mutate of [
    (value: ApprovalObservation) => { value.instanceId = 'other-instance'; },
    (value: ApprovalObservation) => { value.corpId = 'other-corp'; },
    (value: ApprovalObservation) => { value.templateId = 'other-template'; },
    (value: ApprovalObservation) => { value.applicantDingUserId = 'other-applicant'; },
    (value: ApprovalObservation) => { value.approverDingUserIds = ['other-approver']; },
  ]) {
    const observed = observation();
    mutate(observed);
    assert.equal(matches(row, observed), false);
  }
});

test('rejects an approval chain whose approvers are reordered', () => {
  const orderedRow = {
    ...row,
    snapshot: {
      ...row.snapshot,
      approvers: [
        { employeeId: 'employee-2', dingUserId: 'ding-2', role: 'MANAGER' },
        { employeeId: 'employee-3', dingUserId: 'ding-3', role: 'SERVICE_OWNER' },
      ],
    },
  };
  const observed = observation();
  observed.approverDingUserIds = ['ding-3', 'ding-2'];

  assert.equal(matches(orderedRow, observed), false);
});

test('rejects missing, altered, or unsupported request bindings', () => {
  const mutations: Array<(value: ApprovalObservation) => void> = [
    value => { value.requestBinding.reference = 'other-approval'; },
    value => { value.requestBinding.serviceCode = 'OTHER-SERVICE'; },
    value => { value.requestBinding.formVersion += 1; },
    value => { value.requestBinding.requestedValidityDays += 1; },
    value => { value.requestBinding.request.fields.model = 'model-b'; },
    value => { value.requestBinding = undefined as unknown as ApprovalObservation['requestBinding']; },
  ];

  for (const mutate of mutations) {
    const observed = observation();
    mutate(observed);
    assert.equal(matches(row, observed), false);
  }
});
