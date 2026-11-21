import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFulfillmentFixture, fulfillmentSql as sql, literal as q } from '../support/fulfillment.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const base = 'http://127.0.0.1:8088/api/v1';
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
async function report(group, user, extra = '', day = today) {
  const response = await fetch(`${base}/reports/responsibility-history?groupId=${encodeURIComponent(group)}&from=${day}&to=${day}${extra}`,
    { headers: { 'X-Dev-User': user }, signal: AbortSignal.timeout(20000) });
  return { status: response.status, data: await response.json() };
}
const count = async id => Number(await sql(`SELECT count(*) FROM ticket_responsibility_history WHERE ticket_id=${q(id)}`));
const source = await createFulfillmentFixture({ state: null });
const target = await createFulfillmentFixture({ state: null });
const viewer = `history-viewer-${randomUUID()}`, destinationViewer = `history-target-${randomUUID()}`;
const engineer = `history-engineer-${randomUUID()}`;
await sql(`INSERT INTO employees(id,display_name) VALUES(${q(viewer)},'History viewer'),
  (${q(destinationViewer)},'Destination viewer'),(${q(engineer)},'Original engineer name');
  INSERT INTO group_memberships(employee_id,group_id) VALUES(${q(viewer)},${q(source.groupId)}),
    (${q(engineer)},${q(source.groupId)}),(${q(destinationViewer)},${q(target.groupId)});
  UPDATE support_groups SET name='Private destination group' WHERE id=${q(target.groupId)}`);

assert.equal((await report(source.groupId, 'employee-1', '&serviceType=REQ')).status, 404);
assert.equal((await report(source.groupId, destinationViewer, '&serviceType=REQ')).status, 404);
for (const extra of ['&serviceType=ALL', '&serviceType=REQ&serviceType=INC', '&ownerScope=PERSON',
  '&ownerScope=UNASSIGNED&employeeId=agent-1', '&ownerScope=ALL&ownerScope=PERSON',
  '&ownerScope=PERSON&employeeId=a&employeeId=b'])
  assert.equal((await report(source.groupId, viewer, extra)).status, 400, extra);
assert.equal((await report(source.groupId, viewer, '', '2025-02-30')).status, 400);
const reversed = await fetch(`${base}/reports/responsibility-history?groupId=${source.groupId}&from=2025-06-11&to=2025-06-10`,
  { headers: { 'X-Dev-User': viewer } });
assert.equal(reversed.status, 400);
const oversized = await fetch(`${base}/reports/responsibility-history?groupId=${source.groupId}&from=2025-06-10&to=2025-07-11`,
  { headers: { 'X-Dev-User': viewer } });
assert.equal(oversized.status, 400);

assert.equal(await count(source.ticketId), 1);
await sql(`UPDATE tickets SET created_at='2025-06-10 09:00:00+08',description='Private history description',
  version=version+1 WHERE id=${q(source.ticketId)}`);
assert.equal(await count(source.ticketId), 1, 'creation-date edits and unrelated version changes must not fabricate history');
await sql(`BEGIN; UPDATE tickets SET assignee_id=${q(engineer)},status='WAITING_USER',version=version+1
  WHERE id=${q(source.ticketId)}; ROLLBACK;`);
assert.equal(await count(source.ticketId), 1, 'journal entries roll back with the ticket');
await sql(`UPDATE tickets SET assignee_id=${q(engineer)},status='WAITING_USER',version=version+1 WHERE id=${q(source.ticketId)}`);
await sql(`UPDATE tickets SET pending_group_id=${q(target.groupId)},pending_assignee_id='agent-2',assignment_kind='HANDOVER',
  assignment_state='PENDING',assignment_offered_at=now(),version=version+1 WHERE id=${q(source.ticketId)}`);
let result = await report(source.groupId, viewer, '&serviceType=REQ');
assert.equal(result.status, 200, JSON.stringify(result));
assert.equal(result.data.attribution, 'HISTORICAL_OWNER_GROUP');
assert.equal(result.data.windowBasis, 'INTERVAL_OVERLAP');
assert.equal(result.data.durationBasis, 'WALL_CLOCK_SECONDS');
assert.equal(result.data.timeZone, 'Asia/Shanghai');
assert.ok(result.data.items.some(item => item.ticketId === source.ticketId && item.pendingAcceptance && item.assigneeId === engineer));
assert.ok(result.data.responsibility.every(item => item.employeeId !== 'agent-2'), 'pending target is not an accepted historical owner');
assert.equal(result.data.metrics.tickets, 1, 'multiple state observations do not count as multiple tickets');
assert.ok(result.data.metrics.waitingUserWallSeconds > 0);
for (const item of result.data.items) {
  assert.ok(Date.parse(item.from) >= Date.parse(`${today}T00:00:00+08:00`));
  assert.ok(Date.parse(item.until) <= Date.parse(result.data.asOf));
  assert.ok(Date.parse(item.until) > Date.parse(item.from));
  assert.ok(Math.abs(item.elapsedSeconds - (Date.parse(item.until) - Date.parse(item.from)) / 1000) < 0.002);
}
for (const secret of [target.groupId, 'Private destination group', source.internalMarker, 'Private history description', source.subject])
  assert.equal(JSON.stringify(result.data).includes(secret), false, `history must not disclose ${secret}`);
const unassigned = await report(source.groupId, viewer, '&serviceType=REQ&ownerScope=UNASSIGNED');
assert.ok(unassigned.data.items.length > 0);
assert.ok(unassigned.data.items.every(item => item.assigneeId === null));
assert.ok(unassigned.data.responsibility.some(item => item.employeeId === engineer), 'personal filter retains authorized cohort options');
const old = await report(source.groupId, viewer, '&serviceType=REQ', '2025-06-10');
assert.equal(old.status, 200);
assert.equal(old.data.windowStartsBeforeRecording, true);
assert.deepEqual(old.data.items, [], 'backdated creation does not backdate the observation journal');

await sql(`UPDATE employees SET display_name='Renamed engineer' WHERE id=${q(engineer)};
  UPDATE tickets SET status='WAITING_VENDOR',version=version+1 WHERE id=${q(source.ticketId)};
  UPDATE employees SET active=false WHERE id=${q(engineer)}`);
const renamed = await report(source.groupId, viewer, `&serviceType=REQ&ownerScope=PERSON&employeeId=${engineer}`);
assert.equal(renamed.status, 200);
assert.deepEqual(new Set(renamed.data.items.map(item => item.assigneeName)), new Set(['Original engineer name', 'Renamed engineer']));
assert.equal(renamed.data.metrics.tickets, 1, 'disabled owners keep their recorded history');
assert.equal((await report(source.groupId, engineer, '&serviceType=REQ')).status, 401);
await sql(`UPDATE tickets SET owner_group_id=${q(target.groupId)},assignee_id='agent-2',pending_group_id=NULL,pending_assignee_id=NULL,
  assignment_kind=NULL,assignment_state='ACCEPTED',assignment_offered_at=NULL,status='IN_PROGRESS',version=version+1
  WHERE id=${q(source.ticketId)}`);
result = await report(source.groupId, viewer, '&serviceType=REQ');
assert.equal(result.status, 200);
assert.ok(result.data.items.some(item => item.ticketId === source.ticketId && item.assigneeId === engineer),
  'the former owning group retains only its own historical intervals after transfer');
assert.equal(JSON.stringify(result.data).includes(target.groupId), false);
assert.equal(JSON.stringify(result.data).includes('agent-2'), false);
assert.equal((await report(target.groupId, viewer, '&serviceType=REQ')).status, 404);
const targetHistory = await report(target.groupId, destinationViewer, '&serviceType=REQ');
assert.equal(targetHistory.status, 200);
assert.ok(targetHistory.data.items.some(item => item.ticketId === source.ticketId && item.assigneeId === 'agent-2'));
assert.equal(JSON.stringify(targetHistory.data).includes(engineer), false);
const inc = await report(source.groupId, viewer);
assert.deepEqual(inc.data.items, [], 'INC is the default and excludes request history');

const concurrentBefore = await count(source.ticketId);
await Promise.all(Array.from({ length: 8 }, () => sql(`UPDATE tickets SET version=version+1,
  status=CASE WHEN status='WAITING_USER' THEN 'WAITING_VENDOR' ELSE 'WAITING_USER' END WHERE id=${q(source.ticketId)}`)));
assert.equal(await count(source.ticketId), concurrentBefore + 8);
assert.equal(await sql(`SELECT bool_and(revision=sequence AND (prior_at IS NULL OR observed_at>=prior_at))
  FROM (SELECT revision,observed_at,row_number() OVER(ORDER BY revision) AS sequence,
    lag(observed_at) OVER(ORDER BY revision) AS prior_at FROM ticket_responsibility_history WHERE ticket_id=${q(source.ticketId)}) h`), 't');
await sql(`UPDATE tickets SET status='CLOSED',version=version+1 WHERE id=${q(source.ticketId)}`);
const closed = await report(target.groupId, destinationViewer, '&serviceType=REQ');
const activeOnly = closed.data.items.filter(item => !['CLOSED', 'CANCELLED', 'REJECTED'].includes(item.status));
assert.ok(closed.data.items.some(item => item.ticketId === source.ticketId && item.status === 'CLOSED'));
assert.ok(Math.abs(closed.data.metrics.activeWallSeconds - activeOnly.reduce((sum, item) => sum + item.elapsedSeconds, 0)) < 0.001);
const beforeReopen = await count(source.ticketId);
await sql(`UPDATE tickets SET status='IN_PROGRESS',version=version+1 WHERE id=${q(source.ticketId)}`);
assert.equal(await count(source.ticketId), beforeReopen + 1, 'reopening appends instead of overwriting terminal history');
const reopened = await report(target.groupId, destinationViewer, '&serviceType=REQ');
assert.equal(reopened.status, 200);
assert.ok(reopened.data.items.some(item => item.ticketId === source.ticketId && item.status === 'CLOSED'));
assert.ok(reopened.data.items.some(item => item.ticketId === source.ticketId && item.status === 'IN_PROGRESS'));
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
const future = await fetch(`${base}/reports/responsibility-history?groupId=${target.groupId}&from=${today}&to=${tomorrow}&serviceType=REQ`,
  { headers:{ 'X-Dev-User':destinationViewer }, signal:AbortSignal.timeout(20000) });
assert.equal(future.status, 200);
const futureData = await future.json();
assert.ok(futureData.items.every(item => Date.parse(item.until) <= Date.parse(futureData.asOf)),
  'an open interval ends at the query snapshot, not at a requested future date');
assert.deepEqual((await report(target.groupId, destinationViewer, '&serviceType=REQ', tomorrow)).data.items, []);

for (const query of [`UPDATE ticket_responsibility_history SET status='IN_PROGRESS' WHERE ticket_id=${q(source.ticketId)}`,
  `DELETE FROM ticket_responsibility_history WHERE ticket_id=${q(source.ticketId)}`, 'TRUNCATE ticket_responsibility_history',
  'UPDATE responsibility_recording SET started_at=now()', 'DELETE FROM responsibility_recording', 'TRUNCATE responsibility_recording']) {
  const rejected = await sql(query, false);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.error, /RESPONSIBILITY_HISTORY_APPEND_ONLY/);
}

// Run the actual migration against an isolated legacy-shaped table, then roll back all DDL.
const migration = await readFile(new URL('../../db/migrations/031_responsibility_history.sql', import.meta.url), 'utf8');
const schema = `history_${randomUUID().replaceAll('-', '')}`;
const legacyGenId = randomUUID();
const baseline = await sql(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema},public;
  CREATE TABLE tickets (LIKE public.tickets INCLUDING ALL);
  INSERT INTO tickets SELECT * FROM public.tickets WHERE id=${q(source.ticketId)};
  INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,
    form_version,subject,description,fields,impact,urgency,priority,initial_priority,status,created_at)
    VALUES(${q(legacyGenId)},${q(`GEN-${legacyGenId}`)},'employee-1','employee-1',${q(source.groupId)},
      'GEN-OTHER','GEN',1,'Synthetic legacy GEN','Disposable migration fixture','{}','INDIVIDUAL','MEDIUM','P3','P3',
      'QUEUED','2025-06-10 09:00:00+08');
  ${migration}
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM ticket_responsibility_history h JOIN tickets t ON t.id=h.ticket_id
      CROSS JOIN responsibility_recording r WHERE h.source='BASELINE' AND h.revision=1 AND h.observed_at=r.started_at
        AND h.observed_at>t.created_at+interval '1 day') THEN RAISE EXCEPTION 'LEGACY_HISTORY_BACKFILLED'; END IF;
  END $$;
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM ticket_responsibility_history WHERE ticket_id=${q(legacyGenId)} AND source='BASELINE' AND revision=1
      AND service_type='GEN' AND service_code='GEN-OTHER') THEN RAISE EXCEPTION 'LEGACY_GEN_BASELINE_MISSING'; END IF;
  END $$;
  UPDATE tickets SET status='WAITING_VENDOR',version=version+1 WHERE id=${q(source.ticketId)};
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM ticket_responsibility_history WHERE revision=2 AND source='CHANGE')
      THEN RAISE EXCEPTION 'LEGACY_CAPTURE_MISSING'; END IF;
  END $$;
  UPDATE tickets SET service_routing_snapshot='{"version":"legacy-unknown"}',version=version+1
    WHERE id=${q(source.ticketId)};
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM ticket_responsibility_history WHERE revision=3 AND routing_version='legacy-unknown')
      THEN RAISE EXCEPTION 'LEGACY_ROUTING_VERSION_REJECTED'; END IF;
  END $$;
  INSERT INTO ticket_responsibility_history(ticket_id,revision,source,observed_at,ticket_number,ticket_version,
    responsibility_epoch,owner_group_id,owner_group_name,assignee_id,assignee_name,status,service_code,service_type)
  SELECT ticket_id,revision+1,'CHANGE',clock_timestamp()+interval '1 hour',ticket_number,ticket_version,
    responsibility_epoch,owner_group_id,owner_group_name,assignee_id,assignee_name,status,service_code,service_type
    FROM ticket_responsibility_history WHERE revision=3;
  UPDATE tickets SET status='WAITING_USER',version=version+1 WHERE id=${q(source.ticketId)};
  DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM ticket_responsibility_history h JOIN ticket_responsibility_history p
      ON p.ticket_id=h.ticket_id AND p.revision=h.revision-1 WHERE h.revision=5 AND h.clock_adjusted AND h.observed_at=p.observed_at)
      THEN RAISE EXCEPTION 'CLOCK_REVERSAL_NOT_CLAMPED'; END IF;
  END $$;
  SELECT 'LEGACY_BASELINE_VERIFIED'; ROLLBACK;`);
assert.ok(baseline.includes('LEGACY_BASELINE_VERIFIED'));

// Synthetic append-only observations exhaust the report limit only in the disposable CI database.
const crowded = await createFulfillmentFixture({ state:null });
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES(${q(viewer)},${q(crowded.groupId)});
  INSERT INTO ticket_responsibility_history(ticket_id,revision,source,observed_at,ticket_number,ticket_version,
    responsibility_epoch,owner_group_id,owner_group_name,assignee_id,assignee_name,status,service_code,service_type)
  SELECT h.ticket_id,h.revision+n,'CHANGE',h.observed_at+n*interval '1 microsecond',h.ticket_number,h.ticket_version,
    h.responsibility_epoch,h.owner_group_id,h.owner_group_name,h.assignee_id,h.assignee_name,h.status,h.service_code,h.service_type
    FROM ticket_responsibility_history h CROSS JOIN generate_series(1,5000) n WHERE h.ticket_id=${q(crowded.ticketId)} AND h.revision=1;`);
for (const filter of ['', '&ownerScope=PERSON&employeeId=no-matching-owner']) {
  const limited = await report(crowded.groupId, viewer, `&serviceType=REQ${filter}`);
  assert.equal(limited.status, 503, 'personal filtering cannot hide a truncated full-group distribution');
  assert.equal(limited.data.code, 'REPORT_HISTORY_WINDOW_TOO_LARGE');
  assert.equal(limited.data.items, undefined, 'never return a partial report with apparent totals');
}
await sql(`DELETE FROM group_memberships WHERE employee_id=${q(viewer)}`);
assert.equal((await report(source.groupId, viewer, '&serviceType=REQ')).status, 404);
console.log('Historical responsibility verified: atomic journal, legacy unknown baseline, overlap and snapshot clipping, pending/actual owners, concurrency, reopen, clock reversal, snapshot names, group isolation and explicit report limit');
