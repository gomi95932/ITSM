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
  const report = { runId: randomUUID(), ticketIds: [], checks: [] };
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
    const acceptReplay = await request(`${path}/actions`, 'agent-1', 'POST', acceptBody, key('accept'));
    check(acceptReplay, 200, 'ACCEPTANCE_ACTION_REPLAY_FAILED');
    require(acceptReplay.data.version === 2, 'ACCEPTANCE_ACTION_REPLAY_FAILED');
    check(await request(`${path}/actions`, 'agent-1', 'POST', { action: 'RESOLVE', expectedVersion: 1 }, key('stale')),
      409, 'ACCEPTANCE_STALE_WRITE_FAILED');
    const resolved = await request(`${path}/actions`, 'agent-1', 'POST', {
      action: 'RESOLVE', expectedVersion: 2, comment: 'Synthetic acceptance resolved',
      resolutionCategory: 'FIX', evidence: `Synthetic internal evidence ${report.runId}`,
    }, key('resolve'));
    check(resolved, 200, 'ACCEPTANCE_RESOLVE_FAILED');
    require(resolved.data.status === 'PENDING_CONFIRMATION' && resolved.data.version === 3, 'ACCEPTANCE_RESOLVE_STATE_FAILED');
    const closed = await request(`${path}/actions`, 'employee-1', 'POST', { action: 'CONFIRM', expectedVersion: 3 }, key('confirm'));
    check(closed, 200, 'ACCEPTANCE_CONFIRM_FAILED');
    require(closed.data.status === 'CLOSED' && closed.data.version === 4, 'ACCEPTANCE_CLOSED_STATE_FAILED');
    check(await request(`${path}/actions`, 'employee-1', 'POST', { action: 'REOPEN', expectedVersion: 4, reason: 'Synthetic check' }, key('closed-reopen')),
      409, 'ACCEPTANCE_CLOSED_REOPEN_FAILED');
    const detail = await request(path, 'employee-1');
    check(detail, 200, 'ACCEPTANCE_DETAIL_FAILED');
    require(detail.data.status === 'CLOSED' && detail.data.version === 4 && Array.isArray(detail.data.events)
      && detail.data.events.length === 4 && detail.data.events.every(event => !('evidence' in (event.detail ?? {}))),
    'ACCEPTANCE_EMPLOYEE_DETAIL_FAILED');
    check(await request(path, 'employee-2'), 404, 'ACCEPTANCE_CLOSED_CROSS_USER_FAILED');
    report.checks.push('action-idempotency', 'stale-write-conflict', 'agent-resolution', 'requester-confirmation', 'internal-evidence-hidden');
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
