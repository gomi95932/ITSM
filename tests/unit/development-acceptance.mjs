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

test('development acceptance verifies the owner and feedback on isolated synthetic tickets', async () => {
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
        run = { createKey, payload: body, id: randomUUID(), status: 'QUEUED', version: 1, actions: new Map() };
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
      return reply({ id: run.id, status: run.status, version: run.version,
        assigneeId: run.assigneeId, feedback: run.feedback, canFeedback: !run.feedback,
        events: Array.from({ length: run.version }, () => ({ detail: {} })) });
    }
    assert.equal(options.method, 'POST');
    if (match[2] === '/feedback') {
      assert.equal(user, 'employee-1');
      assert.equal(run.status, 'CLOSED');
      if (fault !== 'feedback') run.feedback = { rating: body.rating, comment: body.comment };
      return reply({ rating: body.rating, comment: body.comment });
    }
    const actionKey = options.headers['idempotency-key'];
    if (run.actions.has(actionKey)) return reply(run.actions.get(actionKey));
    if (body.expectedVersion !== run.version || run.status === 'CLOSED'
      || (body.action !== 'CONFIRM' && user !== 'agent-1')) return reply({}, 409);
    const next = { ACCEPT: 'IN_PROGRESS', RESOLVE: 'PENDING_CONFIRMATION', CONFIRM: 'CLOSED' }[body.action];
    assert.ok(next);
    if (body.action === 'CONFIRM') assert.equal(user, 'employee-1');
    if (body.action === 'ACCEPT' && fault !== 'owner') run.assigneeId = user;
    run.status = next;
    run.version++;
    const result = { id: run.id, status: run.status, version: run.version, assigneeId: run.assigneeId };
    run.actions.set(actionKey, result);
    return reply(result);
  };
  const options = { baseUrl: 'http://127.0.0.1:8088', allowSyntheticWrites: true, fetchImpl };
  const first = await verifyDevelopment(options);
  const second = await verifyDevelopment(options);
  assert.equal(first.status, 'passed');
  assert.equal(second.status, 'passed');
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.ticketIds[0], second.ticketIds[0]);
  assert.equal(runs.length, 2);
  assert.ok(runs.every(run => run.status === 'CLOSED' && run.version === 4 && run.feedback.rating === 4));
  assert.ok(first.checks.includes('personal-ownership'));
  assert.ok(first.checks.includes('requester-feedback'));

  fault = 'owner';
  await assert.rejects(verifyDevelopment(options), { message: 'ACCEPTANCE_PERSONAL_OWNER_REQUIRED' });
  fault = 'feedback';
  await assert.rejects(verifyDevelopment(options), { message: 'ACCEPTANCE_FEEDBACK_PERSISTENCE_FAILED' });
});
