import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8088/api/v1/tickets';
let counter = 0;
async function request(path, user, method = 'GET', body, key) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-dev-user': user, ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify({ contentClass:'GENERAL', ...body }),
  });
  return { status: response.status, data: await response.json() };
}
const key = () => `ci-${Date.now()}-${++counter}`;
const body = { serviceCode: 'INC-BIZ', formVersion: 1, subject: 'WMS login fails', description: 'Cannot enter WMS', impact: 'INDIVIDUAL', urgency: 'MEDIUM', fields: {} };
const createKey = key();

const created = await request('', 'employee-1', 'POST', body, createKey);
assert.equal(created.status, 201, JSON.stringify(created));
assert.equal(created.data.status, 'QUEUED');
assert.equal(created.data.ownerGroupId, 'service-desk');
const id = created.data.id;
assert.deepEqual((await request('', 'employee-1', 'POST', body, createKey)).data, created.data);
assert.equal((await request('', 'employee-1', 'POST', { ...body, subject: 'Changed' }, createKey)).status, 409);
assert.equal((await request('', 'employee-1', 'POST', { ...body, userId: 'agent-1' }, key())).status, 400);
assert.equal((await request('', 'employee-1', 'POST', { ...body, formVersion: 999 }, key())).status, 409);
assert.equal((await request(`/${id}`, 'employee-2')).status, 404);
assert.equal((await request(`/${id}`, 'agent-1')).status, 200);
assert.equal((await request('', 'employee-2')).data.items.length, 0);
assert.equal((await request('?mine=false', 'agent-1')).data.items.some(item => item.id === id), true);
assert.equal((await request('', 'unknown')).status, 401);
assert.equal((await request(`/${id}/actions`, 'employee-2', 'POST', { action: 'ACCEPT', expectedVersion: 1 }, key())).status, 404);
assert.equal((await request(`/${id}/actions`, 'employee-1', 'POST', { action: 'ACCEPT', expectedVersion: 1 }, key())).status, 409);

const acceptedKey = key();
const accepted = await request(`/${id}/actions`, 'agent-1', 'POST', { action: 'ACCEPT', expectedVersion: 1,comment:'正在排查' }, acceptedKey);
assert.equal(accepted.status, 200);
assert.equal(accepted.data.version, 2);
assert.deepEqual((await request(`/${id}/actions`, 'agent-1', 'POST', { action: 'ACCEPT', expectedVersion: 1,comment:'正在排查' }, acceptedKey)).data, accepted.data);
assert.equal((await request(`/${id}/actions`, 'agent-1', 'POST', { action: 'RESOLVE', expectedVersion: 1 }, key())).status, 409);
const resolved = await request(`/${id}/actions`, 'agent-1', 'POST', { action: 'RESOLVE', expectedVersion: 2, comment: 'Fixed', resolutionCategory: 'FIX', evidence: 'Login verified' }, key());
assert.equal(resolved.data.status, 'PENDING_CONFIRMATION');
const closed = await request(`/${id}/actions`, 'employee-1', 'POST', { action: 'CONFIRM', expectedVersion: 3 }, key());
assert.equal(closed.data.status, 'CLOSED');
assert.equal((await request(`/${id}/actions`, 'employee-1', 'POST', { action: 'REOPEN', expectedVersion: 4, reason: 'Again' }, key())).status, 409);
const detail = await request(`/${id}`, 'employee-1');
assert.equal(detail.data.events.length, 4);
assert.equal(detail.data.events.some(event => 'evidence' in event.detail), false);
const concurrentKey = key();
const concurrent = await Promise.all(Array.from({ length: 50 }, () => request('', 'employee-1', 'POST', body, concurrentKey)));
assert.equal(concurrent.every(result => result.status === 201), true);
assert.equal(new Set(concurrent.map(result => result.data.id)).size, 1);
assert.notEqual(concurrent[0].data.number, created.data.number);
console.log('Ticket API integration passed:', id);
