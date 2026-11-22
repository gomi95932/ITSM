import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFulfillmentFixture, fulfillmentSql as sql, literal as q } from '../support/fulfillment.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base = 'http://127.0.0.1:8088/api/v1';
async function request(path, user = 'agent-1', body, key = randomUUID()) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Dev-User': user, 'Idempotency-Key': key },
    body: body ? JSON.stringify({ contentClass: 'GENERAL', ...body }) : undefined });
  return { status: response.status, data: await response.json() };
}
async function ok(promise) {
  const result = await promise; assert.equal(result.status, 200, JSON.stringify(result)); return result.data;
}
const get = (f, user) => request(`/tickets/${f.ticketId}`, user);
const action = (f, version, action, extra = {}, user = 'agent-1', key) =>
  request(`/tickets/${f.ticketId}/actions`, user, { action, expectedVersion: version, ...extra }, key);
const future = () => new Date(Date.now() + 86400000).toISOString();
const userWait = () => ({ comment: 'Please confirm the affected location', waitingReason: 'USER_INFORMATION', dueAt: future() });
const vendorWait = () => ({ comment: 'Waiting for an external part', waitingReason: 'VENDOR_PARTS', dueAt: future(),
  vendorReference: 'PRIVATE-VENDOR-REFERENCE', vendorOwner: 'Internal follow-up engineer' });
async function effects(f) {
  return sql(`SELECT jsonb_build_object('ticket',to_jsonb(t)-ARRAY['ownership_checked_at','sla_checked_at'],
    'cycles',(SELECT jsonb_agg(to_jsonb(s) ORDER BY cycle) FROM sla_cycles s WHERE s.ticket_id=t.id),
    'events',(SELECT count(*) FROM ticket_events e WHERE e.ticket_id=t.id),
    'audits',(SELECT count(*) FROM audit_logs a WHERE a.ticket_id=t.id),
    'outbox',(SELECT count(*) FROM outbox_events o JOIN ticket_events e ON e.id=o.event_id WHERE e.ticket_id=t.id))::text
    FROM tickets t WHERE t.id=${q(f.ticketId)}`);
}
const f = await createFulfillmentFixture({ state: null });
await sql(`UPDATE tickets SET created_at='2025-05-22 10:00:00+08' WHERE id=${q(f.ticketId)};
  INSERT INTO sla_cycles(ticket_id,cycle,priority,calendar_snapshot,started_at,response_target,resolution_target)
    SELECT ${q(f.ticketId)},1,'P1',config||jsonb_build_object('version',version,'approved',approved),
      now()-interval '1 hour',1000000,1000000 FROM sla_calendars ORDER BY version DESC LIMIT 1`);
let ticket = await ok(action(f, 1, 'ACCEPT', { comment: 'I own this request' }));
assert.equal((await ok(get(f))).waiting, null);

// Invalid waits must roll back the idempotency reservation and every business write.
for (const [name, type, body, code] of [
  ['missing reason', 'REQUEST_INFO', { ...userWait(), waitingReason: undefined }, 'WAITING_REASON_REQUIRED'],
  ['cross-type reason', 'REQUEST_INFO', { ...userWait(), waitingReason: 'VENDOR_SUPPORT' }, 'WAITING_REASON_REQUIRED'],
  ['unknown reason', 'REQUEST_INFO', { ...userWait(), waitingReason: 'SECRET_FREE_TEXT' }, 'WAITING_REASON_REQUIRED'],
  ['missing deadline', 'REQUEST_INFO', { ...userWait(), dueAt: undefined }, 'INFO_REQUEST_REQUIRES_QUESTION_AND_DUE_DATE'],
  ['invalid date', 'REQUEST_INFO', { ...userWait(), dueAt: '2026-02-30T10:00:00.000Z' }, 'INFO_REQUEST_REQUIRES_QUESTION_AND_DUE_DATE'],
  ['past deadline', 'REQUEST_INFO', { ...userWait(), dueAt: '2020-01-01T00:00:00.000Z' }, 'WAITING_FOLLOW_UP_MUST_BE_FUTURE'],
  ['vendor reason', 'WAIT_VENDOR', { ...vendorWait(), waitingReason: 'USER_AVAILABILITY' }, 'WAITING_REASON_REQUIRED'],
  ['vendor deadline', 'WAIT_VENDOR', { ...vendorWait(), dueAt: undefined }, 'WAITING_FOLLOW_UP_REQUIRED'],
  ['vendor reference', 'WAIT_VENDOR', { ...vendorWait(), vendorReference: '' }, 'VENDOR_REFERENCE_REQUIRED'],
  ['vendor owner', 'WAIT_VENDOR', { ...vendorWait(), vendorOwner: '' }, 'VENDOR_OWNER_REQUIRED'],
  ['unrelated action', 'RESOLVE', { comment: 'No metadata injection', resolutionCategory: 'CONFIGURATION',
    evidence: 'Synthetic resolution evidence', waitingReason: 'USER_INFORMATION' }, 'INVALID_WAITING_REASON'],
]) {
  const before = await effects(f), key = randomUUID();
  if (name === 'missing reason') await sql(`UPDATE tickets SET ownership_checked_at=clock_timestamp(),
    sla_checked_at=clock_timestamp() WHERE id=${q(f.ticketId)}`);
  const rejected = await action(f, ticket.version, type, body, 'agent-1', key);
  assert.equal(rejected.status, 400, `${name}: ${JSON.stringify(rejected)}`);
  assert.equal(rejected.data.code, code, name);
  assert.equal(await effects(f), before, `${name}: no ticket/SLA/event/audit/outbox mutation`);
  assert.equal(await sql(`SELECT count(*) FROM api_idempotency WHERE actor_id='agent-1' AND key=${q(key)}`), '0');
}
assert.equal((await action(f, ticket.version, 'REQUEST_INFO', userWait(), 'agent-2')).status, 409, 'a peer cannot pause someone else\'s ticket');

const key = randomUUID(), body = userWait();
const replay = await Promise.all([action(f, ticket.version, 'REQUEST_INFO', body, 'agent-1', key),
  action(f, ticket.version, 'REQUEST_INFO', body, 'agent-1', key)]);
replay.forEach(result => assert.equal(result.status, 200, JSON.stringify(result)));
assert.deepEqual(replay[0].data, replay[1].data); ticket = replay[0].data;
let detail = await ok(get(f));
assert.equal(detail.waiting.reason, 'USER_INFORMATION'); assert.equal(detail.waiting.dueAt, body.dueAt);
assert.equal(detail.waiting.followUpOverdue, false); assert.equal(detail.sla[0].paused, true);
assert.equal(await sql(`SELECT waiting_since>clock_timestamp()-interval '1 minute' AND waiting_since<=clock_timestamp()
  FROM tickets WHERE id=${q(f.ticketId)}`), 't', 'wait start comes from the database clock');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id
  JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id=${q(f.ticketId)} AND e.action='REQUEST_INFO'
  AND e.detail->>'waitingReason'='USER_INFORMATION' AND e.detail->>'dueAt'=${q(body.dueAt)}`), '1');
await sql(`UPDATE sla_cycles SET paused_at=clock_timestamp()-interval '30 minutes' WHERE ticket_id=${q(f.ticketId)}`);
detail = await ok(get(f));
assert.equal(detail.sla[0].responded, false, 'fake notification is not a real first response');
assert.ok(detail.sla[0].responseMinutes - detail.sla[0].resolutionMinutes >= 29, 'user wait pauses resolution, not response');
ticket = await ok(action(f, ticket.version, 'ADD_INFO', { comment: 'Location clarified' }, 'employee-1'));
detail = await ok(get(f)); assert.equal(detail.waiting, null); assert.equal(detail.sla[0].paused, false);
assert.equal(await sql(`SELECT waiting_reason_code IS NULL AND waiting_since IS NULL AND waiting_due_at IS NULL
  FROM tickets WHERE id=${q(f.ticketId)}`), 't');

ticket = await ok(action(f, ticket.version, 'WAIT_VENDOR', vendorWait()));
const preserved = (await ok(get(f))).waiting;
assert.equal((await ok(get(f))).sla[0].paused, false, 'vendor wait never pauses SLA');
ticket = await ok(action(f, ticket.version, 'REASSIGN', { targetGroupId: f.groupId, targetAssigneeId: 'agent-2', reason: 'Peer follows up' }));
assert.deepEqual((await ok(get(f))).waiting, preserved, 'offering a handover preserves the wait');
assert.equal((await ok(get(f))).assigneeId, 'agent-1');
assert.equal((await action(f,ticket.version,'RESUME_VENDOR',{comment:'Not yet the owner'},'agent-2')).data.code,
  'PERSONAL_OWNER_REQUIRED','pending recipient cannot resume before accepting responsibility');
ticket = await ok(action(f, ticket.version, 'ACCEPT_HANDOVER', { comment: 'I accept the follow-up' }, 'agent-2'));
assert.deepEqual((await ok(get(f, 'agent-2'))).waiting, preserved, 'accepted handover preserves wait timestamps');
assert.equal(ticket.assigneeId, 'agent-2');
await sql(`UPDATE tickets SET waiting_since=clock_timestamp()-interval '2 hours',waiting_due_at=clock_timestamp()-interval '1 hour'
  WHERE id=${q(f.ticketId)}`);
detail = await ok(get(f, 'agent-2')); assert.equal(detail.waiting.followUpOverdue, true);
assert.equal(detail.status, 'WAITING_VENDOR'); assert.equal(detail.sla[0].paused, false);
assert.equal(detail.sla[0].breached, false, 'follow-up deadline is not an SLA target');

const legacy = await createFulfillmentFixture({ groupId: f.groupId, state: null });
await sql(`UPDATE tickets SET status='WAITING_USER',created_at='2025-05-22 11:00:00+08' WHERE id=${q(legacy.ticketId)}`);
const unknown = { reason: 'UNRECORDED', since: null, dueAt: null, followUpOverdue: null };
assert.deepEqual((await ok(get(legacy))).waiting, unknown, 'legacy waits remain unknown');
const window = `?groupId=${f.groupId}&from=2025-05-22&to=2025-05-22&serviceType=REQ`;
let report = await ok(request(`/reports/summary${window}`));
assert.equal(report.metrics.waitingFollowUpOverdue, 1); assert.equal(report.metrics.waitingUnrecorded, 1);
assert.equal(report.metrics.overdueTickets, 0);
assert.deepEqual(report.waiting, [
  { status: 'WAITING_VENDOR', reason: 'VENDOR_PARTS', tickets: 1, followUpOverdue: 1 },
  { status: 'WAITING_USER', reason: 'UNRECORDED', tickets: 1, followUpOverdue: null },
]);
assert.equal(JSON.stringify(report).includes('PRIVATE-VENDOR-REFERENCE'), false);
report = await ok(request(`/reports/summary${window}&ownerScope=PERSON&employeeId=agent-2&serviceCode=${f.serviceCode}`));
assert.deepEqual(report.items.map(row => row.id), [f.ticketId]); assert.equal(report.waiting.length, 1);
assert.equal((await request(`/reports/summary${window}`, 'employee-1')).status, 404);
assert.equal((await request(`/reports/summary${window}`, 'employee-2')).status, 404);

// Resuming is an owner action in the same workflow; rejected requests leave no business writes.
for(const [user,extra,status,code] of [
  ['agent-1',{comment:'Previous owner'},409,'PERSONAL_OWNER_REQUIRED'],
  ['employee-1',{comment:'Requester is not an engineer'},409,'OWNER_GROUP_REQUIRED'],
  ['agent-2',{},400,'VENDOR_RESUME_COMMENT_REQUIRED'],
  ['agent-2',{comment:'   '},400,'VENDOR_RESUME_COMMENT_REQUIRED'],
  ['agent-2',{comment:'No metadata injection',waitingReason:'VENDOR_PARTS'},400,'INVALID_WAITING_REASON'],
]) {
  const before=await effects(f),key=randomUUID();
  const rejected=await action(f,ticket.version,'RESUME_VENDOR',extra,user,key);
  assert.equal(rejected.status,status,JSON.stringify(rejected)); assert.equal(rejected.data.code,code);
  assert.equal(await effects(f),before,'rejected resume must roll back ticket/SLA/event/audit/outbox');
  assert.equal(await sql(`SELECT count(*) FROM api_idempotency WHERE actor_id=${q(user)} AND key=${q(key)}`),'0');
}
const beforeResume=await effects(f);
const resumeCycles=await sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY cycle)::text FROM sla_cycles s WHERE ticket_id=${q(f.ticketId)}`);
const resumeKey=randomUUID(),resumeBody={comment:'Replacement received; continuing service verification'};
const resumed=await Promise.all([1,2].map(()=>action(f,ticket.version,'RESUME_VENDOR',resumeBody,'agent-2',resumeKey)));
resumed.forEach(result=>assert.equal(result.status,200,JSON.stringify(result)));
assert.deepEqual(resumed[0].data,resumed[1].data);
const waitingVersion=ticket.version;ticket=resumed[0].data;
assert.equal(ticket.status,'IN_PROGRESS');assert.equal(ticket.version,waitingVersion+1);
assert.equal(ticket.assigneeId,'agent-2');
detail=await ok(get(f,'agent-2'));assert.equal(detail.waiting,null);
assert.equal(await sql(`SELECT waiting_reason_code IS NULL AND waiting_since IS NULL AND waiting_due_at IS NULL
  FROM tickets WHERE id=${q(f.ticketId)}`),'t');
assert.equal(await sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY cycle)::text FROM sla_cycles s WHERE ticket_id=${q(f.ticketId)}`),resumeCycles,
  'resume neither restarts, pauses, completes nor counts as first response');
assert.equal(await sql(`SELECT count(*) FROM ticket_events e JOIN audit_logs a ON a.event_id=e.id
  JOIN outbox_events o ON o.event_id=e.id WHERE e.ticket_id=${q(f.ticketId)} AND e.action='RESUME_VENDOR'
  AND e.from_status='WAITING_VENDOR' AND e.to_status='IN_PROGRESS' AND e.detail->>'comment'=${q(resumeBody.comment)}`),'1');
const afterResume=await effects(f);
assert.notEqual(afterResume,beforeResume);
assert.equal((await action(f,waitingVersion,'RESUME_VENDOR',resumeBody,'agent-2')).data.code,'VERSION_CONFLICT');
assert.equal((await action(f,ticket.version,'RESUME_VENDOR',resumeBody,'agent-2')).data.code,'INVALID_TRANSITION');
assert.equal(await effects(f),afterResume,'stale or duplicate transitions cannot create another event');
ticket=await ok(action(f,ticket.version,'WAIT_VENDOR',vendorWait(),'agent-2'));
assert.equal(ticket.status,'WAITING_VENDOR');
assert.equal((await ok(get(f,'agent-2'))).waiting.followUpOverdue,false,'new wait receives a new future deadline');

// Direct SQL cannot retain partial/mismatched metadata or nonfinite timestamps.
for (const mutation of [
  `waiting_reason_code=NULL`, `waiting_reason_code='USER_INFORMATION'`, `waiting_due_at=waiting_since`,
  `waiting_due_at='infinity'::timestamptz`, `waiting_since='-infinity'::timestamptz`,
]) assert.notEqual((await sql(`UPDATE tickets SET ${mutation} WHERE id=${q(f.ticketId)}`, false)).code, 0, mutation);
await sql(`UPDATE tickets SET status='WAITING_USER' WHERE id=${q(f.ticketId)}`);
assert.deepEqual((await ok(get(f))).waiting, unknown, 'raw type changes do not carry stale vendor reasons');
await sql(`UPDATE tickets SET status='IN_PROGRESS' WHERE id=${q(f.ticketId)}`);
assert.equal((await ok(get(f))).waiting, null);
assert.equal(await sql(`SELECT waiting_reason_code IS NULL AND waiting_since IS NULL AND waiting_due_at IS NULL
  FROM tickets WHERE id=${q(f.ticketId)}`), 't');
console.log('Structured waiting verified: atomic validation, replay, user-only resolution pause, owner-only vendor resume with unchanged SLA, ownership continuity, scoped reports and unknown legacy metadata');
