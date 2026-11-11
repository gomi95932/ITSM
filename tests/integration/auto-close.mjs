import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base = 'http://127.0.0.1:8088/api/v1';

async function request(path, user, body) {
  const response = await fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Dev-User': user, 'Idempotency-Key': randomUUID(),
  }, body: JSON.stringify({ contentClass: 'GENERAL', ...body }) });
  return { status: response.status, data: await response.json() };
}

async function sql(query) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '--project-name', 'itsm-dev', '--env-file', process.env.ITSM_CI_ENV,
      '-f', 'infra/compose/compose.yaml', 'exec', '-T', 'db', 'sh', '-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"', 'sh', query],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('AUTO_CLOSE_FIXTURE_SQL_FAILED')));
  });
}

let ticket = await request('/tickets', 'employee-1', { serviceCode: 'INC-BIZ', formVersion: 1,
  subject: `Confirmation clock ${randomUUID()}`, description: 'WMS access unavailable',
  impact: 'INDIVIDUAL', urgency: 'MEDIUM', fields: {} });
assert.equal(ticket.status, 201, JSON.stringify(ticket));
const id = ticket.data.id;
for (const [action, extra] of [['ACCEPT', { comment: 'Investigating' }],
  ['RESOLVE', { comment: 'Restored', resolutionCategory: 'FIX', evidence: 'Verified' }]]) {
  ticket = await request(`/tickets/${id}/actions`, 'agent-1', { action, expectedVersion: ticket.data.version, ...extra });
  assert.equal(ticket.status, 200, JSON.stringify(ticket));
}
assert.equal(ticket.data.status, 'PENDING_CONFIRMATION');
// A later ticket update must not reset the clock started by RESOLVE.
await sql(`UPDATE sla_cycles SET completed_at=now()-interval '73 hours' WHERE ticket_id='${id}';
  UPDATE tickets SET updated_at=now() WHERE id='${id}'`);
let closed = false;
for (let i = 0; i < 70; i++) {
  if (await sql(`SELECT status FROM tickets WHERE id='${id}'`) === 'CLOSED') { closed = true; break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(closed, true, 'worker must close after the resolution-based confirmation window');
assert.equal(await sql(`SELECT count(*) FROM ticket_events WHERE ticket_id='${id}' AND action='AUTO_CLOSE'`), '1');
assert.equal(await sql(`SELECT count(*) FROM audit_logs a JOIN ticket_events e ON e.id=a.event_id
  JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id='${id}' AND e.action='AUTO_CLOSE'`), '1');
const feedback = await request(`/tickets/${id}/feedback`, 'employee-1', { rating: 5 });
assert.equal(feedback.status, 200, JSON.stringify(feedback));
assert.equal(await sql(`SELECT count(*) FROM ticket_feedback WHERE ticket_id='${id}'`), '1');
console.log('Resolution-based auto-close verified with updated ticket timestamp and audit/outbox');
