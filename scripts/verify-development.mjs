import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateAcceptanceTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_ACCEPTANCE_TARGET'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('LOOPBACK_ACCEPTANCE_TARGET_REQUIRED');
  return url.origin;
}

export async function verifyDevelopment({ baseUrl, allowSyntheticWrites = false, fetchImpl = fetch } = {}) {
  const base = validateAcceptanceTarget(baseUrl);
  if (allowSyntheticWrites !== true) throw new Error('EXPLICIT_SYNTHETIC_WRITES_APPROVAL_REQUIRED');
  const report = { profile: 'phase1-waiting-v2', runId: randomUUID(), ticketIds: [], checks: [] };
  let stage = 'preflight';
  const require = (condition, code) => { if (!condition) throw new Error(code); };
  const request = async (path, user, method = 'GET', body, key) => {
    const payload = body !== undefined && method === 'POST' && path.endsWith('/actions')
      ? { ...body, contentClass: 'GENERAL' } : body;
    const response = await fetchImpl(`${base}/api/v1${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { ...(user ? { 'x-dev-user': user } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, data: await response.json() };
  };
  const check = (result, status, code) => require(result.status === status, code);
  const key = label => `acceptance-${report.runId}-${label}`;
  try {
    const ready = await request('/health/ready');
    check(ready, 200, 'ACCEPTANCE_NOT_READY');
    require(ready.data.status === 'ok', 'ACCEPTANCE_NOT_READY');
    const config = await request('/auth/config');
    check(config, 200, 'ACCEPTANCE_AUTH_CONFIG_FAILED');
    require(config.data.mode === 'development', 'DEVELOPMENT_AUTH_REQUIRED');
    for (const [user, agent] of [['employee-1', false], ['employee-2', false], ['agent-1', true]]) {
      const identity = await request('/auth/me', user);
      check(identity, 200, 'DEVELOPMENT_FIXTURES_REQUIRED');
      require(identity.data.id === user && Array.isArray(identity.data.groups)
        && (agent ? identity.data.groups.includes('service-desk') : identity.data.groups.length === 0), 'DEVELOPMENT_FIXTURES_REQUIRED');
    }
    check(await request('/tickets'), 401, 'ANONYMOUS_ACCESS_NOT_BLOCKED');
    report.checks.push('readiness', 'development-fixtures', 'anonymous-access');

    stage = 'create';
    const payload = { contentClass: 'GENERAL', serviceCode: 'INC-BIZ', formVersion: 1,
      subject: `ITSM deployment acceptance ${report.runId}`,
      description: 'Synthetic development acceptance ticket. No employee or production data.',
      impact: 'INDIVIDUAL', urgency: 'MEDIUM', fields: {} };
    const created = await request('/tickets', 'employee-1', 'POST', payload, key('create'));
    check(created, 201, 'ACCEPTANCE_CREATE_FAILED');
    require(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(created.data.id ?? ''), 'ACCEPTANCE_TICKET_ID_INVALID');
    const id = created.data.id;
    report.ticketIds.push(id);
    require(created.data.status === 'QUEUED' && created.data.version === 1
      && created.data.ownerGroupId === 'service-desk', 'ACCEPTANCE_INITIAL_STATE_FAILED');
    stage = 'boundaries';
    const replay = await request('/tickets', 'employee-1', 'POST', payload, key('create'));
    check(replay, 201, 'ACCEPTANCE_CREATE_REPLAY_FAILED');
    require(replay.data.id === id && replay.data.version === created.data.version, 'ACCEPTANCE_CREATE_REPLAY_FAILED');
    check(await request('/tickets', 'employee-1', 'POST', { ...payload, subject: 'Changed synthetic payload' }, key('create')),
      409, 'ACCEPTANCE_IDEMPOTENCY_CONFLICT_FAILED');
    const path = `/tickets/${id}`;
    check(await request(path, 'employee-2'), 404, 'ACCEPTANCE_CROSS_USER_READ_FAILED');
    check(await request(`${path}/actions`, 'employee-2', 'POST', { action: 'ACCEPT', expectedVersion: 1 }, key('other-accept')),
      404, 'ACCEPTANCE_CROSS_USER_WRITE_FAILED');
    check(await request(`${path}/actions`, 'employee-1', 'POST', { action: 'ACCEPT', expectedVersion: 1 }, key('employee-accept')),
      409, 'ACCEPTANCE_EMPLOYEE_ROLE_FAILED');
    check(await request(path, 'agent-1'), 200, 'ACCEPTANCE_AGENT_READ_FAILED');
    report.checks.push('create-idempotency', 'cross-user-isolation', 'employee-role');

    stage = 'lifecycle';
    const acceptBody = { action: 'ACCEPT', expectedVersion: 1, comment: 'Synthetic acceptance investigation' };
    const accepted = await request(`${path}/actions`, 'agent-1', 'POST', acceptBody, key('accept'));
    check(accepted, 200, 'ACCEPTANCE_ACCEPT_FAILED');
    require(accepted.data.status === 'IN_PROGRESS' && accepted.data.version === 2, 'ACCEPTANCE_ACCEPT_VERSION_FAILED');
    require(accepted.data.assigneeId === 'agent-1', 'ACCEPTANCE_PERSONAL_OWNER_REQUIRED');
    const acceptReplay = await request(`${path}/actions`, 'agent-1', 'POST', acceptBody, key('accept'));
    check(acceptReplay, 200, 'ACCEPTANCE_ACTION_REPLAY_FAILED');
    require(acceptReplay.data.version === 2, 'ACCEPTANCE_ACTION_REPLAY_FAILED');
    check(await request(`${path}/actions`, 'agent-1', 'POST', { action: 'RESOLVE', expectedVersion: 1 }, key('stale')),
      409, 'ACCEPTANCE_STALE_WRITE_FAILED');

    const detailAt = async (status, version) => {
      const result = await request(path, 'agent-1');
      check(result, 200, 'ACCEPTANCE_AGENT_DETAIL_FAILED');
      require(result.data.status === status && result.data.version === version
        && Array.isArray(result.data.events) && result.data.events.length === version,
      'ACCEPTANCE_WAITING_STATE_FAILED');
      require(result.data.assigneeId === 'agent-1', 'ACCEPTANCE_PERSONAL_OWNER_REQUIRED');
      require(Array.isArray(result.data.sla) && result.data.sla.length === 1
        && result.data.sla[0].completed === false, 'ACCEPTANCE_WAITING_SLA_REQUIRED');
      return result.data;
    };
    const waitMatches = (detail, reason, dueAt) => require(detail.waiting?.reason === reason
      && detail.waiting.dueAt === dueAt && Number.isFinite(Date.parse(detail.waiting.since))
      && Date.parse(detail.waiting.since) < Date.parse(dueAt)
      && detail.waiting.followUpOverdue === false, 'ACCEPTANCE_WAITING_METADATA_FAILED');
    stage = 'user-waiting';
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    const infoBody = { action: 'REQUEST_INFO', expectedVersion: 2, comment: 'Synthetic request for location details',
      waitingReason: 'USER_INFORMATION', dueAt };
    check(await request(`${path}/actions`, 'agent-1', 'POST', { ...infoBody, waitingReason: 'VENDOR_SUPPORT' }, key('invalid-wait')),
      400, 'ACCEPTANCE_INVALID_WAIT_NOT_REJECTED');
    const unchanged = await detailAt('IN_PROGRESS', 2);
    require(unchanged.waiting === null && unchanged.sla[0].paused === false, 'ACCEPTANCE_INVALID_WAIT_MUTATED');
    const waiting = await request(`${path}/actions`, 'agent-1', 'POST', infoBody, key('user-wait'));
    check(waiting, 200, 'ACCEPTANCE_USER_WAIT_FAILED');
    require(waiting.data.status === 'WAITING_USER' && waiting.data.version === 3, 'ACCEPTANCE_USER_WAIT_FAILED');
    const userWaitReplay = await request(`${path}/actions`, 'agent-1', 'POST', infoBody, key('user-wait'));
    check(userWaitReplay, 200, 'ACCEPTANCE_WAIT_REPLAY_FAILED');
    require(userWaitReplay.data.version === 3, 'ACCEPTANCE_WAIT_REPLAY_FAILED');
    const userWaiting = await detailAt('WAITING_USER', 3);
    waitMatches(userWaiting, 'USER_INFORMATION', dueAt);
    require(userWaiting.sla[0].paused === true && userWaiting.sla[0].pauseReason === 'USER', 'ACCEPTANCE_USER_WAIT_SLA_FAILED');
    check(await request(`${path}/actions`, 'employee-2', 'POST', {
      action: 'ADD_INFO', expectedVersion: 3, comment: 'Another employee must not supplement this ticket',
    }, key('other-supplement')), 404, 'ACCEPTANCE_CROSS_USER_SUPPLEMENT_FAILED');
    const supplemented = await request(`${path}/actions`, 'employee-1', 'POST', {
      action: 'ADD_INFO', expectedVersion: 3, comment: 'Synthetic location confirmed',
    }, key('supplement'));
    check(supplemented, 200, 'ACCEPTANCE_SUPPLEMENT_FAILED');
    require(supplemented.data.status === 'IN_PROGRESS' && supplemented.data.version === 4, 'ACCEPTANCE_SUPPLEMENT_FAILED');
    const resumed = await detailAt('IN_PROGRESS', 4);
    require(resumed.waiting === null && resumed.sla[0].paused === false && resumed.sla[0].pauseReason === null,
      'ACCEPTANCE_USER_WAIT_NOT_CLEARED');
    report.checks.push('waiting-validation', 'waiting-idempotency', 'user-waiting-resolution-pause',
      'requester-supplement-resume', 'cross-user-supplement-isolation');

    stage = 'vendor-waiting';
    const vendorBody = {
      action: 'WAIT_VENDOR', expectedVersion: 4, comment: 'Synthetic external investigation',
      waitingReason: 'VENDOR_SUPPORT', dueAt,
      vendorReference: `Synthetic private vendor reference ${report.runId}`, vendorOwner: 'Synthetic follow-up engineer',
    };
    const vendorWait = await request(`${path}/actions`, 'agent-1', 'POST', vendorBody, key('vendor-wait'));
    check(vendorWait, 200, 'ACCEPTANCE_VENDOR_WAIT_FAILED');
    require(vendorWait.data.status === 'WAITING_VENDOR' && vendorWait.data.version === 5, 'ACCEPTANCE_VENDOR_WAIT_FAILED');
    const vendorWaiting = await detailAt('WAITING_VENDOR', 5);
    waitMatches(vendorWaiting, 'VENDOR_SUPPORT', dueAt);
    require(vendorWaiting.sla[0].paused === false && vendorWaiting.sla[0].pauseReason === null,
      'ACCEPTANCE_VENDOR_WAIT_PAUSED_SLA');
    report.checks.push('vendor-waiting-sla-continues');

    stage = 'vendor-resume';
    const resumeBody = { action: 'RESUME_VENDOR', expectedVersion: 5, comment: 'Synthetic vendor response verified' };
    check(await request(`${path}/actions`, 'employee-1', 'POST', resumeBody, key('requester-resume')),
      409, 'ACCEPTANCE_VENDOR_RESUME_OWNER_REQUIRED');
    check(await request(`${path}/actions`, 'agent-1', 'POST', { ...resumeBody, comment: '   ' }, key('empty-resume')),
      400, 'ACCEPTANCE_VENDOR_RESUME_COMMENT_REQUIRED');
    await detailAt('WAITING_VENDOR', 5);
    const vendorResume = await request(`${path}/actions`, 'agent-1', 'POST', resumeBody, key('vendor-resume'));
    check(vendorResume, 200, 'ACCEPTANCE_VENDOR_RESUME_FAILED');
    require(vendorResume.data.status === 'IN_PROGRESS' && vendorResume.data.version === 6,
      'ACCEPTANCE_VENDOR_RESUME_FAILED');
    const resumeReplay = await request(`${path}/actions`, 'agent-1', 'POST', resumeBody, key('vendor-resume'));
    check(resumeReplay, 200, 'ACCEPTANCE_VENDOR_RESUME_REPLAY_FAILED');
    require(JSON.stringify(resumeReplay.data) === JSON.stringify(vendorResume.data), 'ACCEPTANCE_VENDOR_RESUME_REPLAY_FAILED');
    const processing = await detailAt('IN_PROGRESS', 6);
    require(processing.waiting === null, 'ACCEPTANCE_VENDOR_RESUME_NOT_CLEARED');
    const stableSla = detail => JSON.stringify(detail.sla.map(row => Object.fromEntries([
      'cycle', 'priority', 'responseTarget', 'resolutionTarget', 'responded', 'completed', 'paused', 'pauseReason',
      'calendarApproved', 'calendarVersion',
    ].map(field => [field, row[field]]))));
    require(stableSla(processing) === stableSla(vendorWaiting), 'ACCEPTANCE_VENDOR_RESUME_SLA_CHANGED');
    report.checks.push('vendor-resume-owner-boundary', 'vendor-resume-comment', 'vendor-resume-idempotency',
      'vendor-resume-clears-metadata', 'vendor-resume-sla-preserved');

    stage = 'vendor-waiting';
    const secondWait = await request(`${path}/actions`, 'agent-1', 'POST', { ...vendorBody, expectedVersion: 6 }, key('vendor-wait-again'));
    check(secondWait, 200, 'ACCEPTANCE_VENDOR_WAIT_FAILED');
    require(secondWait.data.status === 'WAITING_VENDOR' && secondWait.data.version === 7, 'ACCEPTANCE_VENDOR_WAIT_FAILED');
    waitMatches(await detailAt('WAITING_VENDOR', 7), 'VENDOR_SUPPORT', dueAt);

    stage = 'lifecycle';
    const resolved = await request(`${path}/actions`, 'agent-1', 'POST', {
      action: 'RESOLVE', expectedVersion: 7, comment: 'Synthetic acceptance resolved',
      resolutionCategory: 'FIX', evidence: `Synthetic internal evidence ${report.runId}`,
    }, key('resolve'));
    check(resolved, 200, 'ACCEPTANCE_RESOLVE_FAILED');
    require(resolved.data.status === 'PENDING_CONFIRMATION' && resolved.data.version === 8, 'ACCEPTANCE_RESOLVE_STATE_FAILED');
    const closed = await request(`${path}/actions`, 'employee-1', 'POST', { action: 'CONFIRM', expectedVersion: 8 }, key('confirm'));
    check(closed, 200, 'ACCEPTANCE_CONFIRM_FAILED');
    require(closed.data.status === 'CLOSED' && closed.data.version === 9, 'ACCEPTANCE_CLOSED_STATE_FAILED');
    check(await request(`${path}/actions`, 'employee-1', 'POST', { action: 'REOPEN', expectedVersion: 9, reason: 'Synthetic check' }, key('closed-reopen')),
      409, 'ACCEPTANCE_CLOSED_REOPEN_FAILED');
    const detail = await request(path, 'employee-1');
    check(detail, 200, 'ACCEPTANCE_DETAIL_FAILED');
    require(detail.data.status === 'CLOSED' && detail.data.version === 9 && Array.isArray(detail.data.events)
      && detail.data.events.map(event => event.action).join(',')
        === 'SUBMIT_AND_ROUTE,ACCEPT,REQUEST_INFO,ADD_INFO,WAIT_VENDOR,RESUME_VENDOR,WAIT_VENDOR,RESOLVE,CONFIRM'
      && detail.data.events.every(event => ['evidence', 'vendorReference', 'vendorOwner'].every(field => !(field in (event.detail ?? {})))),
    'ACCEPTANCE_EMPLOYEE_DETAIL_FAILED');
    require(detail.data.waiting === null, 'ACCEPTANCE_CLOSED_WAIT_NOT_CLEARED');
    require(detail.data.assigneeId === 'agent-1', 'ACCEPTANCE_PERSONAL_OWNER_REQUIRED');
    check(await request(path, 'employee-2'), 404, 'ACCEPTANCE_CLOSED_CROSS_USER_FAILED');
    report.checks.push('action-idempotency', 'stale-write-conflict', 'personal-ownership', 'agent-resolution',
      'requester-confirmation', 'internal-evidence-hidden', 'waiting-closure-clears-metadata');

    stage = 'feedback';
    const feedbackBody = { contentClass: 'GENERAL', rating: 4, comment: 'Synthetic acceptance feedback' };
    check(await request(`${path}/feedback`, 'employee-2', 'POST', feedbackBody, key('other-feedback')),
      404, 'ACCEPTANCE_CROSS_USER_FEEDBACK_FAILED');
    const feedback = await request(`${path}/feedback`, 'employee-1', 'POST', feedbackBody, key('feedback'));
    check(feedback, 200, 'ACCEPTANCE_FEEDBACK_FAILED');
    const evaluated = await request(path, 'employee-1');
    check(evaluated, 200, 'ACCEPTANCE_FEEDBACK_READ_FAILED');
    require(evaluated.data.feedback?.rating === feedbackBody.rating
      && evaluated.data.feedback?.comment === feedbackBody.comment && evaluated.data.canFeedback === false
      && evaluated.data.status === 'CLOSED' && evaluated.data.version === closed.data.version,
    'ACCEPTANCE_FEEDBACK_PERSISTENCE_FAILED');
    report.checks.push('requester-feedback');
    return { ...report, status: 'passed', completedAt: new Date().toISOString() };
  } catch (error) {
    const failure = new Error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'DEVELOPMENT_ACCEPTANCE_FAILED');
    failure.report = { ...report, status: 'failed', stage, completedAt: new Date().toISOString() };
    throw failure;
  }
}

export async function main(argv) {
  let baseUrl, allowSyntheticWrites = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url' && !baseUrl && argv[i + 1]) baseUrl = argv[++i];
    else if (argv[i] === '--allow-synthetic-writes' && !allowSyntheticWrites) allowSyntheticWrites = true;
    else throw new Error('INVALID_ACCEPTANCE_ARGUMENT');
  }
  console.log(JSON.stringify(await verifyDevelopment({ baseUrl, allowSyntheticWrites })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ error: error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message : 'DEVELOPMENT_ACCEPTANCE_FAILED', ...(error.report ? { report: error.report } : {}) }));
    process.exitCode = 1;
  });
}
