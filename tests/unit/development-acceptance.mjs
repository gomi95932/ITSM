import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { validateAcceptanceTarget, verifyDevelopment } from '../../scripts/verify-development.mjs';

test('development acceptance only targets an explicit loopback HTTP origin', () => {
  assert.equal(validateAcceptanceTarget('http://127.0.0.1:18088'), 'http://127.0.0.1:18088');
  for (const value of [undefined, '', 'https://127.0.0.1:8088', 'http://10.10.81.125:8088',
    'http://localhost:8088', 'http://127.0.0.1.example.com', 'http://user:secret@127.0.0.1:8088',
    'http://127.0.0.1:8088/api', 'http://127.0.0.1:8088/?token=secret', 'http://127.0.0.1/#secret']) {
    assert.throws(() => validateAcceptanceTarget(value));
  }
});

test('development acceptance cannot send requests without explicit synthetic write approval', async () => {
  let calls = 0;
  await assert.rejects(verifyDevelopment({ baseUrl: 'http://127.0.0.1:8088', fetchImpl: async () => { calls++; } }),
    /EXPLICIT_SYNTHETIC_WRITES_APPROVAL_REQUIRED/);
  assert.equal(calls, 0);
});

test('development acceptance fails before writes when real authentication is enabled', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    calls++;
    return Response.json(url.endsWith('/health/ready') ? { status: 'ok' } : { mode: 'dingtalk' });
  };
  await assert.rejects(verifyDevelopment({ baseUrl: 'http://127.0.0.1:8088', allowSyntheticWrites: true, fetchImpl }),
    /DEVELOPMENT_AUTH_REQUIRED/);
  assert.equal(calls, 2);
});

test('development acceptance requires exact synthetic identities and group boundaries before writing', async () => {
  for (const identity of [{ id: 'real-person', groups: [] }, { id: 'employee-1', groups: ['service-desk'] },
    { id: 'employee-1' }]) {
    let calls = 0;
    const fetchImpl = async (url, options) => {
      assert.equal(options.method, 'GET');
      calls++;
      return Response.json(url.endsWith('/health/ready') ? { status: 'ok' }
        : url.endsWith('/auth/config') ? { mode: 'development' } : identity);
    };
    await assert.rejects(verifyDevelopment({ baseUrl: 'http://127.0.0.1:8088', allowSyntheticWrites: true, fetchImpl }),
      /DEVELOPMENT_FIXTURES_REQUIRED/);
    assert.equal(calls, 3);
  }
});

test('development acceptance does not leak response errors or configuration in failure output', async () => {
  const secret = 'do-not-print-upstream-response-or-credentials';
  await assert.rejects(verifyDevelopment({ baseUrl: 'http://127.0.0.1:8088', allowSyntheticWrites: true,
    fetchImpl: async () => { throw new Error(secret); } }), error => {
    assert.equal(error.message, 'DEVELOPMENT_ACCEPTANCE_FAILED');
    assert.equal(error.report.stage, 'preflight');
    assert.deepEqual(error.report.ticketIds, []);
    assert.equal(JSON.stringify(error.report).includes(secret), false);
    return true;
  });
});

test('development acceptance verifies owner, waiting, SLA boundaries and feedback on isolated synthetic tickets', async () => {
  const runs = [];
  let fault;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname.replace('/api/v1', '');
    const user = options.headers['x-dev-user'];
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (options.method === 'POST') assert.equal(body.contentClass, 'GENERAL');
    const reply = (data, status = 200) => Response.json(data, { status });
    if (path === '/health/ready') return reply({ status: 'ok' });
    if (path === '/auth/config') return reply({ mode: 'development' });
    if (path === '/auth/me') return reply({ id: user, groups: user === 'agent-1' ? ['service-desk'] : [] });
    if (path === '/tickets' && options.method === 'GET') {
      assert.equal(user, undefined);
      return reply({}, 401);
    }
    if (path === '/tickets' && options.method === 'POST') {
      const createKey = options.headers['idempotency-key'];
      let run = runs.find(item => item.createKey === createKey);
      if (!run) {
        assert.equal(user, 'employee-1');
        assert.match(body.subject, /^ITSM deployment acceptance /);
        run = { createKey, payload: body, id: randomUUID(), status: 'QUEUED', version: 1, actions: new Map(),
          waiting: null, paused: false, pauseReason: null, events: [{ action: 'SUBMIT_AND_ROUTE', detail: {} }] };
        runs.push(run);
      }
      if (JSON.stringify(run.payload) !== JSON.stringify(body)) return reply({}, 409);
      return reply({ id: run.id, status: 'QUEUED', version: 1, ownerGroupId: 'service-desk' }, 201);
    }
    const match = /^\/tickets\/([a-f0-9-]+)(\/actions|\/feedback)?$/.exec(path);
    assert.ok(match, `unexpected request ${options.method} ${path}`);
    const run = runs.find(item => item.id === match[1]);
    assert.ok(run, 'only this verifier\'s synthetic tickets may be addressed');
    if (user === 'employee-2') return reply({}, 404);
    if (!match[2]) {
      assert.equal(options.method, 'GET');
      const waiting = fault === 'waiting-metadata' && run.waiting ? { ...run.waiting, reason: 'UNRECORDED' }
        : fault === 'waiting-clock' && run.waiting ? { ...run.waiting, since: run.waiting.dueAt } : run.waiting;
      return reply({ id: run.id, status: run.status, version: run.version,
        assigneeId: run.assigneeId, feedback: run.feedback, canFeedback: !run.feedback, waiting,
        sla: fault === 'missing-sla' ? [] : [{ completed: false, paused: run.paused, pauseReason: run.pauseReason }],
        events: run.events.map(event => ({ ...event, detail: fault === 'private-event' && event.action === 'WAIT_VENDOR'
          ? { vendorReference: 'Synthetic private vendor reference' } : {} })) });
    }
    assert.equal(options.method, 'POST');
    if (match[2] === '/feedback') {
      assert.equal(user, 'employee-1');
      assert.equal(run.status, 'CLOSED');
      if (fault !== 'feedback') run.feedback = { rating: body.rating, comment: body.comment };
      return reply({ rating: body.rating, comment: body.comment });
    }
    const actionKey = options.headers['idempotency-key'];
    if (run.actions.has(actionKey) && !(fault === 'wait-replay' && body.action === 'REQUEST_INFO')) return reply(run.actions.get(actionKey));
    if (run.actions.has(actionKey)) return reply({}, 409);
    const requesterAction = ['CONFIRM', 'ADD_INFO'].includes(body.action);
    if (body.action === 'RESUME_VENDOR' && user === 'employee-1' && fault === 'vendor-resume-owner') return reply({});
    if (body.expectedVersion !== run.version || run.status === 'CLOSED'
      || (!requesterAction && user !== 'agent-1')) return reply({}, 409);
    if (body.action === 'RESUME_VENDOR' && !body.comment?.trim())
      return reply({}, fault === 'vendor-resume-comment' ? 200 : 400);
    if (body.action === 'REQUEST_INFO' && body.waitingReason !== 'USER_INFORMATION') {
      if (fault === 'invalid-wait-mutation') run.waiting = { reason: body.waitingReason };
      return reply({}, 400);
    }
    const next = { ACCEPT: 'IN_PROGRESS', REQUEST_INFO: 'WAITING_USER', ADD_INFO: 'IN_PROGRESS',
      WAIT_VENDOR: 'WAITING_VENDOR', RESUME_VENDOR: 'IN_PROGRESS', RESOLVE: 'PENDING_CONFIRMATION', CONFIRM: 'CLOSED' }[body.action];
    assert.ok(next);
    if (requesterAction) assert.equal(user, 'employee-1');
    if (body.action === 'ACCEPT' && fault !== 'owner') run.assigneeId = user;
    if (['REQUEST_INFO', 'WAIT_VENDOR'].includes(body.action)) {
      assert.equal(run.status, 'IN_PROGRESS');
      assert.ok(Date.parse(body.dueAt) > Date.now());
      if (body.action === 'WAIT_VENDOR') {
        assert.equal(body.waitingReason, 'VENDOR_SUPPORT');
        assert.match(body.vendorReference, /^Synthetic private vendor reference /);
        assert.equal(body.vendorOwner, 'Synthetic follow-up engineer');
      }
      run.waiting = { reason: body.waitingReason, since: new Date().toISOString(), dueAt: body.dueAt, followUpOverdue: false };
      run.paused = body.action === 'REQUEST_INFO' ? fault !== 'user-pause' : fault === 'vendor-pause';
      run.pauseReason = run.paused ? 'USER' : null;
    } else if (body.action === 'ADD_INFO') {
      assert.equal(run.status, 'WAITING_USER');
      if (fault !== 'resume-clear') { run.waiting = null; run.paused = false; run.pauseReason = null; }
    } else if (body.action === 'RESUME_VENDOR') {
      assert.equal(run.status, 'WAITING_VENDOR');
      if (fault !== 'vendor-resume-clear') run.waiting = null;
      if (fault === 'vendor-resume-sla') { run.paused = true; run.pauseReason = 'USER'; }
    } else if (body.action === 'RESOLVE' && fault !== 'close-clear') run.waiting = null;
    run.status = next;
    run.version++;
    run.events.push({ action: body.action, detail: {} });
    const result = { id: run.id, status: run.status, version: run.version, assigneeId: run.assigneeId };
    if (!(body.action === 'RESUME_VENDOR' && fault === 'vendor-resume-replay')) run.actions.set(actionKey, result);
    return reply(result);
  };
  const options = { baseUrl: 'http://127.0.0.1:8088', allowSyntheticWrites: true, fetchImpl };
  const first = await verifyDevelopment(options);
  const second = await verifyDevelopment(options);
  assert.equal(first.status, 'passed');
  assert.equal(first.profile, 'phase1-waiting-v2');
  assert.equal(second.status, 'passed');
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.ticketIds[0], second.ticketIds[0]);
  assert.equal(runs.length, 2);
  assert.ok(runs.every(run => run.status === 'CLOSED' && run.version === 9 && run.waiting === null && run.feedback.rating === 4));
  for (const check of ['personal-ownership', 'requester-feedback', 'waiting-validation', 'waiting-idempotency',
    'user-waiting-resolution-pause', 'requester-supplement-resume', 'cross-user-supplement-isolation',
    'vendor-waiting-sla-continues', 'vendor-resume-owner-boundary', 'vendor-resume-comment', 'vendor-resume-idempotency',
    'vendor-resume-clears-metadata', 'vendor-resume-sla-preserved', 'waiting-closure-clears-metadata']) assert.ok(first.checks.includes(check), check);

  for (const [injectedFault, code, stage] of [
    ['owner', 'ACCEPTANCE_PERSONAL_OWNER_REQUIRED', 'lifecycle'],
    ['feedback', 'ACCEPTANCE_FEEDBACK_PERSISTENCE_FAILED', 'feedback'],
    ['invalid-wait-mutation', 'ACCEPTANCE_INVALID_WAIT_MUTATED', 'user-waiting'],
    ['wait-replay', 'ACCEPTANCE_WAIT_REPLAY_FAILED', 'user-waiting'],
    ['missing-sla', 'ACCEPTANCE_WAITING_SLA_REQUIRED', 'user-waiting'],
    ['waiting-metadata', 'ACCEPTANCE_WAITING_METADATA_FAILED', 'user-waiting'],
    ['waiting-clock', 'ACCEPTANCE_WAITING_METADATA_FAILED', 'user-waiting'],
    ['user-pause', 'ACCEPTANCE_USER_WAIT_SLA_FAILED', 'user-waiting'],
    ['resume-clear', 'ACCEPTANCE_USER_WAIT_NOT_CLEARED', 'user-waiting'],
    ['vendor-pause', 'ACCEPTANCE_VENDOR_WAIT_PAUSED_SLA', 'vendor-waiting'],
    ['vendor-resume-owner', 'ACCEPTANCE_VENDOR_RESUME_OWNER_REQUIRED', 'vendor-resume'],
    ['vendor-resume-comment', 'ACCEPTANCE_VENDOR_RESUME_COMMENT_REQUIRED', 'vendor-resume'],
    ['vendor-resume-replay', 'ACCEPTANCE_VENDOR_RESUME_REPLAY_FAILED', 'vendor-resume'],
    ['vendor-resume-clear', 'ACCEPTANCE_VENDOR_RESUME_NOT_CLEARED', 'vendor-resume'],
    ['vendor-resume-sla', 'ACCEPTANCE_VENDOR_RESUME_SLA_CHANGED', 'vendor-resume'],
    ['close-clear', 'ACCEPTANCE_CLOSED_WAIT_NOT_CLEARED', 'lifecycle'],
    ['private-event', 'ACCEPTANCE_EMPLOYEE_DETAIL_FAILED', 'lifecycle'],
  ]) {
    fault = injectedFault;
    await assert.rejects(verifyDevelopment(options), error => {
      assert.equal(error.message, code, injectedFault);
      assert.equal(error.report.stage, stage, injectedFault);
      assert.equal(error.report.ticketIds.length, 1);
      assert.equal(error.report.status, 'failed');
      assert.equal(error.report.profile, 'phase1-waiting-v2');
      return true;
    });
  }
});
