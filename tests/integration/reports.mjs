import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base = 'http://127.0.0.1:8088/api/v1';
const window = '?groupId=service-desk&from=2025-06-10&to=2025-06-10';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

async function request(path, user, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Dev-User': user, 'Idempotency-Key': randomUUID() },
    body: body ? JSON.stringify({ contentClass: 'GENERAL', ...body }) : undefined });
  return { status: response.status, data: await response.json() };
}
async function sql(query) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '--project-name', 'itsm-dev', '--env-file', process.env.ITSM_CI_ENV,
      '-f', 'infra/compose/compose.yaml', 'exec', '-T', 'db', 'sh', '-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"', 'sh', query],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`REPORT_FIXTURE_SQL_FAILED: ${errors}`)));
  });
}
async function create(at) {
  const result = await request('/tickets', 'employee-1', { serviceCode: 'INC-BIZ', formVersion: 1,
    subject: `Report ${randomUUID()}`, description: 'WMS is unavailable', impact: 'INDIVIDUAL', urgency: 'LOW', fields: {} });
  assert.equal(result.status, 201, JSON.stringify(result));
  await sql(`UPDATE tickets SET created_at=${quote(at)}::timestamptz WHERE id=${quote(result.data.id)}`);
  return result.data;
}
async function action(ticket, user, type, extra = {}) {
  const result = await request(`/tickets/${ticket.id}/actions`, user, { action: type, expectedVersion: ticket.version, ...extra });
  assert.equal(result.status, 200, JSON.stringify(result));
  return result.data;
}
const start = await create('2025-06-10 00:00:00+08');
let end = await create('2025-06-10 23:59:59.999+08');
const before = await create('2025-06-09 23:59:59.999+08');
const after = await create('2025-06-11 00:00:00+08');

assert.equal((await request(`/reports/summary${window}`, 'employee-1')).status, 404);
assert.equal((await request(`/reports/summary${window}`, 'agent-2')).status, 404);
assert.equal((await request('/reports/summary?groupId=service-desk&from=2025-02-30&to=2025-03-01', 'agent-1')).status, 400);
assert.equal((await request('/reports/summary?groupId=service-desk&from=2025-06-10&to=2025-07-11', 'agent-1')).status, 400);
assert.equal((await request('/reports/summary?groupId=service-desk&from=2025-06-11&to=2025-06-10', 'agent-1')).status, 400);

let report = await request(`/reports/summary${window}`, 'agent-1');
assert.equal(report.status, 200, JSON.stringify(report));
assert.equal(report.data.timeZone, 'Asia/Shanghai');
assert.equal(report.data.attribution, 'CURRENT_OWNER_GROUP');
assert.deepEqual(new Set(report.data.items.map(item => item.id)), new Set([start.id, end.id]));
assert.ok(!report.data.items.some(item => [before.id, after.id].includes(item.id)));
assert.equal(report.data.metrics.tickets, 2);
assert.equal(report.data.metrics.responded, 0, 'fake notification delivery is not a first response');

let reopened = await action(start, 'agent-1', 'ACCEPT', { comment: 'Investigating' });
reopened = await action(reopened, 'agent-1', 'RESOLVE', { comment: 'Restored', resolutionCategory: 'FIX', evidence: 'Verified' });
reopened = await action(reopened, 'employee-1', 'REOPEN', { reason: 'Still unavailable' });
// Move the closed first cycle into the past to exercise a historical breach; the reopened cycle remains live.
await sql(`UPDATE sla_cycles SET started_at='2025-06-10 09:00:00+08' WHERE ticket_id=${quote(start.id)} AND cycle=1`);
end = await action(end, 'agent-1', 'ACCEPT', { comment: 'Investigating' });
end = await action(end, 'agent-1', 'RESOLVE', { comment: 'Restored', resolutionCategory: 'FIX', evidence: 'Verified' });
end = await action(end, 'employee-1', 'CONFIRM');
const feedback = await request(`/tickets/${end.id}/feedback`, 'employee-1', { rating: 5 });
assert.equal(feedback.status, 200, JSON.stringify(feedback));

report = await request(`/reports/summary${window}`, 'agent-1');
assert.equal(report.status, 200, JSON.stringify(report));
assert.equal(report.data.metrics.reopenedTickets, 1);
assert.equal(report.data.metrics.rated, 1);
assert.equal(report.data.metrics.satisfactionAverage, 5);
assert.equal(report.data.metrics.resolved, 1);
assert.equal(report.data.metrics.overdueTickets, 1);
const item = report.data.items.find(row => row.id === start.id);
assert.equal(item.reopenCount, 1);
assert.equal(item.cycles.length, 2);
assert.equal(item.cycles[0].resolutionOverdue, true);
assert.equal(item.firstResponse.responded, false);
assert.equal(item.resolution.completed, false);

reopened = await action(reopened, 'agent-1', 'REASSIGN', { targetGroupId: 'applications', targetAssigneeId: 'agent-2', reason: 'Application diagnosis' });
reopened = await action(reopened, 'agent-2', 'ACCEPT_HANDOVER', { comment: 'Taking over' });
assert.equal(reopened.ownerGroupId, 'applications');
report = await request(`/reports/summary${window}`, 'agent-1');
assert.equal(report.data.metrics.tickets, 1);
assert.equal(report.data.items[0].id, end.id);
const transferred = await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', 'agent-2');
assert.equal(transferred.status, 200, JSON.stringify(transferred));
assert.equal(transferred.data.items.filter(row => row.id === start.id).length, 1);

const temporary = `report-${randomUUID()}`;
await sql(`INSERT INTO employees(id,display_name) VALUES (${quote(temporary)},'Report reviewer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(temporary)},'applications')`);
assert.equal((await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', temporary)).status, 200);
await sql(`DELETE FROM group_memberships WHERE employee_id=${quote(temporary)}`);
assert.equal((await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', temporary)).status, 404);
console.log('Reports verified: scoped groups, Shanghai dates, delivery-only response, reopen SLA, feedback and transfer attribution');
