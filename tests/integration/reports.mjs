import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createFulfillmentFixture } from '../support/fulfillment.mjs';
import { retireSupportGroup } from '../support/support-groups.mjs';

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
const req = await createFulfillmentFixture({ reviewed: true });
await sql(`UPDATE tickets SET status='CLOSED',owner_group_id='service-desk',created_at='2025-06-10 10:00:00+08' WHERE id=${quote(req.ticketId)};
  INSERT INTO ticket_feedback(ticket_id,requester_id,rating,comment)
    VALUES(${quote(req.ticketId)},'employee-1',3,'Private report fixture comment');
  INSERT INTO sla_cycles(ticket_id,cycle,priority,calendar_snapshot,started_at,completed_at,paused_minutes,response_target,resolution_target)
    SELECT ${quote(req.ticketId)},1,'P1',config||jsonb_build_object('version',version,'approved',approved),
      '2025-06-10 10:00:00+08','2025-06-10 11:30:00+08',60,120,35
    FROM sla_calendars ORDER BY version DESC LIMIT 1`);

assert.equal((await request(`/reports/summary${window}`, 'employee-1')).status, 404);
assert.equal((await request(`/reports/summary${window}`, 'agent-2')).status, 404);
assert.equal((await request('/support-groups','demo-admin-1')).status,200);
assert.equal((await request(`/reports/summary${window}`, 'demo-admin-1')).status,200,'platform administrator can view reports without joining a support group');
assert.equal((await request(`/reports/responsibility-history${window}`, 'demo-admin-1')).status,200);
assert.equal((await request(`/reports/notifications${window}`, 'demo-admin-1')).status,200);
assert.equal((await request(`/reports/summary${window}&serviceType=REQ`, 'employee-1')).status, 404);
assert.equal((await request(`/reports/summary${window}&serviceType=REQ`, 'agent-2')).status, 404);
for (const filter of ['ALL', '', 'INC&serviceType=REQ'])
  assert.equal((await request(`/reports/summary${window}&serviceType=${filter}`, 'agent-1')).status, 400);
for (const filter of ['ownerScope=TEAM', 'ownerScope=PERSON', 'ownerScope=PERSON&employeeId=',
  'ownerScope=ALL&employeeId=agent-1', 'ownerScope=UNASSIGNED&employeeId=agent-1',
  'ownerScope=ALL&ownerScope=PERSON', 'ownerScope=PERSON&employeeId=agent-1&employeeId=agent-2'])
  assert.equal((await request(`/reports/summary${window}&${filter}`, 'agent-1')).status, 400);
for (const filter of ['serviceCode=', 'serviceCode=%20', 'serviceCode=%20INC-BIZ',
  'serviceCode=INC-BIZ&serviceCode=INC-BIZ', `serviceCode=${'x'.repeat(201)}`]) {
  const invalid = await request(`/reports/summary${window}&${filter}`, 'agent-1');
  assert.equal(invalid.status, 400, JSON.stringify(invalid));
  assert.equal(invalid.data.code, 'INVALID_REPORT_SERVICE_FILTER');
}
assert.equal((await request('/reports/summary?groupId=service-desk&from=2025-02-30&to=2025-03-01', 'agent-1')).status, 400);
assert.equal((await request('/reports/summary?groupId=service-desk&from=2025-06-10&to=2025-07-11', 'agent-1')).status, 400);
assert.equal((await request('/reports/summary?groupId=service-desk&from=2025-06-11&to=2025-06-10', 'agent-1')).status, 400);

let report = await request(`/reports/summary${window}`, 'agent-1');
assert.equal(report.status, 200, JSON.stringify(report));
assert.equal(report.data.timeZone, 'Asia/Shanghai');
assert.equal(report.data.attribution, 'CURRENT_OWNER_GROUP');
assert.equal(report.data.serviceType, 'INC');
assert.equal(report.data.ownerAttribution, 'CURRENT_ASSIGNEE');
assert.deepEqual(report.data.ownerFilter, { ownerScope:'ALL', employeeId:null });
assert.ok(Number.isFinite(Date.parse(report.data.asOf)));
assert.deepEqual(new Set(report.data.items.map(item => item.id)), new Set([start.id, end.id]));
assert.ok(!report.data.items.some(item => [before.id, after.id].includes(item.id)));
assert.equal(report.data.metrics.tickets, 2);
assert.equal(report.data.metrics.responded, 0, 'fake notification delivery is not a first response');
assert.equal(report.data.responsibility.length, 1);
assert.equal(report.data.responsibility[0].employeeId, null);
assert.equal(report.data.responsibility[0].metrics.tickets, 2);
assert.equal(report.data.responsibility[0].metrics.active, 2);
const unassigned = await request(`/reports/summary${window}&ownerScope=UNASSIGNED`, 'agent-1');
assert.deepEqual(unassigned.data.items.map(row=>row.id), report.data.items.map(row=>row.id));
const notYetAssigned = await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=agent-1`, 'agent-1');
assert.equal(notYetAssigned.status, 200, JSON.stringify(notYetAssigned));
assert.equal(notYetAssigned.data.metrics.tickets, 0);
assert.deepEqual(notYetAssigned.data.items, []);
assert.equal(notYetAssigned.data.responsibility[0].employeeId, null, 'scope options are based only on this visible group cohort');
const explicitInc = await request(`/reports/summary${window}&serviceType=INC`, 'agent-1');
assert.equal(explicitInc.status, 200, JSON.stringify(explicitInc));
assert.deepEqual(explicitInc.data.items.map(row => row.id), report.data.items.map(row => row.id));
assert.deepEqual(explicitInc.data.metrics, report.data.metrics);
assert.deepEqual(report.data.serviceFilter, { serviceCode:null });
assert.equal(report.data.handoverBasis, 'RECORDED_ACCEPT_HANDOVER_IN_GROUP');
assert.equal(report.data.serviceNameBasis, 'CURRENT_CATALOG');
assert.deepEqual(report.data.services.map(row => row.serviceCode), ['INC-BIZ']);
assert.equal(report.data.services[0].metrics.tickets, 2);
assert.equal(report.data.metrics.acceptedHandovers, 0);
for (const serviceCode of ['UNKNOWN-REPORT-SERVICE', req.serviceCode, "INC-BIZ' OR '1'='1"]) {
  const foreign = await request(`/reports/summary${window}&serviceCode=${encodeURIComponent(serviceCode)}`, 'agent-1');
  assert.equal(foreign.status, 200, JSON.stringify(foreign));
  assert.deepEqual(foreign.data.items, []);
  assert.equal(foreign.data.metrics.tickets, 0);
  assert.deepEqual(foreign.data.services, report.data.services, 'service options never enumerate foreign services');
}

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
const personallyOwned = await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=agent-1`, 'agent-1');
assert.equal(personallyOwned.status, 200, JSON.stringify(personallyOwned));
assert.equal(personallyOwned.data.metrics.tickets, 2);
assert.equal(personallyOwned.data.metrics.active, 1);
assert.deepEqual(personallyOwned.data.metrics, report.data.metrics);
assert.equal(personallyOwned.data.responsibility.length, 1);
assert.equal(personallyOwned.data.responsibility[0].employeeId, 'agent-1');
assert.equal(personallyOwned.data.responsibility[0].name, report.data.items[0].assigneeName);
assert.equal(personallyOwned.data.responsibility[0].active, true);
assert.equal((await request(`/reports/summary${window}&ownerScope=UNASSIGNED`, 'agent-1')).data.metrics.tickets, 0);
const secondService = `INC-RPT-${randomUUID()}`;
await sql(`INSERT INTO service_catalog(code,type,form_version,published,group_id,name,description,required_fields,field_schema,visible_groups)
  SELECT ${quote(secondService)},type,form_version,false,group_id,'Report second service','CI-only service','[]','[]','[]'
  FROM service_catalog WHERE code='INC-BIZ';
  UPDATE tickets SET service_code=${quote(secondService)} WHERE id=${quote(end.id)}`);
const serviceScoped = await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=agent-1&serviceCode=${secondService}`, 'agent-1');
assert.equal(serviceScoped.status, 200, JSON.stringify(serviceScoped));
assert.deepEqual(serviceScoped.data.items.map(row => row.id), [end.id]);
assert.equal(serviceScoped.data.items[0].serviceName, 'Report second service', 'unpublished services retain existing ticket reporting');
assert.equal(serviceScoped.data.metrics.tickets, 1);
assert.equal(serviceScoped.data.metrics.satisfactionAverage, 5);
assert.equal(serviceScoped.data.services.length, 2, 'service breakdown remains the owner-filtered cohort before service filtering');
assert.equal(serviceScoped.data.services.find(row => row.serviceCode === secondService).metrics.rated, 1);
assert.equal(serviceScoped.data.responsibility[0].metrics.tickets, 2, 'owner choices retain the complete group cohort');
await sql(`UPDATE service_catalog SET name='Renamed report service' WHERE code=${quote(secondService)}`);
const renamed = await request(`/reports/summary${window}&serviceCode=${secondService}`, 'agent-1');
assert.equal(renamed.data.services.find(row => row.serviceCode === secondService).name, 'Renamed report service');
assert.equal(renamed.data.items[0].serviceCode, secondService);
assert.equal(renamed.data.items[0].serviceName, 'Renamed report service');
for (const employeeId of ['agent-2', 'employee-1', 'unknown-report-identity']) {
  const foreign = await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=${employeeId}`, 'agent-1');
  assert.equal(foreign.status, 200, JSON.stringify(foreign));
  assert.deepEqual(foreign.data.items, []);
  assert.equal(foreign.data.metrics.tickets, 0);
  assert.deepEqual(foreign.data.services, [], 'no service options from another person outside the cohort');
  assert.ok(foreign.data.responsibility.every(row=>row.employeeId === 'agent-1'));
}

const requests = await request(`/reports/summary${window}&serviceType=REQ`, 'agent-1');
assert.equal(requests.status, 200, JSON.stringify(requests));
assert.equal(requests.data.serviceType, 'REQ');
assert.deepEqual(requests.data.items.map(row => row.id), [req.ticketId]);
assert.equal(requests.data.metrics.rated, 1);
assert.equal(requests.data.metrics.satisfactionAverage, 3);
assert.equal(requests.data.metrics.resolved, 1);
assert.equal(requests.data.metrics.responded, 0);
assert.deepEqual(requests.data.items[0].resolution, { completed:true, minutes:30, target:35, overdue:false });
assert.equal(JSON.stringify(requests.data).includes('Private report fixture comment'), false);
assert.equal(JSON.stringify(requests.data).includes(req.internalMarker), false);
assert.equal(requests.data.responsibility[0].employeeId, null, 'fulfillment executor does not imply accepted ticket ownership');
assert.equal(requests.data.services[0].serviceCode, req.serviceCode);
assert.equal(requests.data.services[0].metrics.resolved, 1);
const personalRequest = await request(`/reports/summary${window}&serviceType=REQ&ownerScope=PERSON&employeeId=agent-1`, 'agent-1');
assert.equal(personalRequest.data.metrics.tickets, 0);
const unassignedRequest = await request(`/reports/summary${window}&serviceType=REQ&ownerScope=UNASSIGNED`, 'agent-1');
assert.deepEqual(unassignedRequest.data.items.map(row=>row.id), [req.ticketId]);
const outsideRequestDate = await request('/reports/summary?groupId=service-desk&from=2025-06-11&to=2025-06-11&serviceType=REQ', 'agent-1');
assert.equal(outsideRequestDate.status, 200, JSON.stringify(outsideRequestDate));
assert.equal(outsideRequestDate.data.items.some(row => row.id === req.ticketId), false);

reopened = await action(reopened, 'agent-1', 'REASSIGN', { targetGroupId: 'applications', targetAssigneeId: 'agent-2', reason: 'Application diagnosis' });
reopened = await action(reopened, 'agent-2', 'DECLINE_HANDOVER', { reason: 'Need additional diagnosis' });
assert.equal((await request(`/reports/summary${window}`, 'agent-1')).data.metrics.acceptedHandovers, 0);
reopened = await action(reopened, 'agent-1', 'REASSIGN', { targetGroupId: 'applications', targetAssigneeId: 'agent-2', reason: 'Application diagnosis' });
reopened = await action(reopened, 'agent-1', 'CANCEL_HANDOVER', { reason: 'Continue locally first' });
assert.equal((await request(`/reports/summary${window}`, 'agent-1')).data.metrics.acceptedHandovers, 0);
reopened = await action(reopened, 'agent-1', 'REASSIGN', { targetGroupId: 'applications', targetAssigneeId: 'agent-2', reason: 'Application diagnosis' });
const pendingHandover = await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=agent-1`, 'agent-1');
assert.equal(pendingHandover.data.metrics.pendingAcceptance, 1);
const pendingItem = pendingHandover.data.items.find(row=>row.id === start.id);
assert.equal(pendingItem.assigneeId, 'agent-1', 'initiating handover does not change accepted responsibility');
assert.equal(pendingItem.pendingAssigneeId, 'agent-2');
assert.equal(pendingItem.assignmentKind, 'HANDOVER');
assert.equal(pendingItem.acceptedHandoverCount, 0, 'pending handover is not a completed responsibility transfer');
assert.ok(pendingHandover.data.responsibility.every(row=>row.employeeId !== 'agent-2'));
reopened = await action(reopened, 'agent-2', 'ACCEPT_HANDOVER', { comment: 'Taking over' });
assert.equal(reopened.ownerGroupId, 'applications');
report = await request(`/reports/summary${window}`, 'agent-1');
assert.equal(report.data.metrics.tickets, 1);
assert.equal(report.data.items[0].id, end.id);
const transferred = await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', 'agent-2');
assert.equal(transferred.status, 200, JSON.stringify(transferred));
assert.equal(transferred.data.items.filter(row => row.id === start.id).length, 1);
const transferredItem = transferred.data.items.find(row=>row.id === start.id);
assert.equal(transferredItem.assigneeId, 'agent-2');
assert.equal(transferredItem.pendingAssigneeId, null);
assert.equal(transferredItem.overdueEver, true, 'handover does not reset whole-ticket SLA history');
assert.equal(transferredItem.acceptedHandoverCount, 1);
assert.equal(transferred.data.metrics.acceptedHandovers, 1);
assert.equal(transferred.data.services.find(row => row.serviceCode === 'INC-BIZ').metrics.acceptedHandovers, 1);
assert.equal(transferred.data.responsibility.find(row => row.employeeId === 'agent-2').metrics.acceptedHandovers, 1);
const repeatAccept = await request(`/tickets/${reopened.id}/actions`, 'agent-2', {
  action:'ACCEPT_HANDOVER', expectedVersion:reopened.version, comment:'Already received' });
assert.equal(repeatAccept.status, 409);
assert.equal((await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', 'agent-2')).data.metrics.acceptedHandovers, 1);
await sql(`INSERT INTO ticket_events(ticket_id,actor_id,action,from_status,to_status,detail,request_id)
  VALUES(${quote(start.id)},'agent-1','ACCEPT_HANDOVER','IN_PROGRESS','IN_PROGRESS',
    '{"targetGroupId":"service-desk","comment":"private-other-group-marker"}','CI-only-other-group-event')`);
const restrictedTransfers = await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', 'agent-2');
assert.equal(restrictedTransfers.data.metrics.acceptedHandovers, 1, 'other group acceptance events are not included');
assert.equal(JSON.stringify(restrictedTransfers.data).includes('private-other-group-marker'), false);
const previousOwner = await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10&ownerScope=PERSON&employeeId=agent-1', 'agent-2');
assert.equal(previousOwner.data.metrics.tickets, 0, 'current attribution never pretends to be historical contribution');

const recordedDay = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const history = await request(`/reports/responsibility-history?groupId=service-desk&from=${recordedDay}&to=${recordedDay}`, 'agent-1');
assert.equal(history.status, 200, JSON.stringify(history));
const priorIntervals = history.data.items.filter(row => row.ticketId === start.id);
assert.ok(priorIntervals.some(row => row.assigneeId === 'agent-1' && row.pendingAcceptance));
assert.ok(priorIntervals.every(row => row.assigneeId !== 'agent-2'), 'accepted API handover retains only the old group intervals');
assert.ok(priorIntervals.some(row => row.status === 'PENDING_CONFIRMATION'));
const acceptedHistory = await request(`/reports/responsibility-history?groupId=applications&from=${recordedDay}&to=${recordedDay}`, 'agent-2');
assert.equal(acceptedHistory.status, 200, JSON.stringify(acceptedHistory));
assert.ok(acceptedHistory.data.items.some(row => row.ticketId === start.id && row.assigneeId === 'agent-2'));

const temporary = `report-${randomUUID()}`;
await sql(`INSERT INTO employees(id,display_name) VALUES (${quote(temporary)},'Report reviewer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES (${quote(temporary)},'applications'),(${quote(temporary)},'service-desk')`);
assert.equal((await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', temporary)).status, 200);
assert.equal((await request(`/reports/summary${window}&serviceType=REQ`, temporary)).status, 200);
const formerOwner = `former-${randomUUID()}`;
await sql(`INSERT INTO employees(id,display_name,active) VALUES (${quote(formerOwner)},'Former report owner',false);
  UPDATE tickets SET assignee_id=${quote(formerOwner)} WHERE id=${quote(end.id)}`);
const inactive = await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=${formerOwner}`, temporary);
assert.equal(inactive.status, 200, JSON.stringify(inactive));
assert.deepEqual(inactive.data.items.map(row=>row.id), [end.id]);
assert.equal(inactive.data.items[0].assigneeActive, false);
assert.equal(inactive.data.responsibility[0].name, 'Former report owner');
assert.equal(inactive.data.metrics.active, 0, 'closed history is retained without creating a current work obligation');
assert.equal((await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=${formerOwner}`, 'agent-2')).status, 404);
await sql(`DELETE FROM group_memberships WHERE employee_id=${quote(temporary)}`);
assert.equal((await request('/reports/summary?groupId=applications&from=2025-06-10&to=2025-06-10', temporary)).status, 404);
assert.equal((await request(`/reports/summary${window}&serviceType=REQ`, temporary)).status, 404);
assert.equal((await request(`/reports/summary${window}&ownerScope=PERSON&employeeId=${formerOwner}`, temporary)).status, 404);

const limitGroup = `report-limit-${randomUUID()}`;
const limitWindow = `?groupId=${limitGroup}&from=2024-01-02&to=2024-01-02&ownerScope=PERSON&employeeId=unknown-owner&serviceCode=UNKNOWN`;
await sql(`INSERT INTO support_groups(id,name) VALUES(${quote(limitGroup)},'CI-only bounded report');
  INSERT INTO group_memberships(employee_id,group_id) VALUES('agent-1',${quote(limitGroup)});
  INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
    subject,description,fields,impact,urgency,priority,status,created_at)
    SELECT gen_random_uuid(),${quote(limitGroup)}||'-'||n,'employee-1','employee-1',${quote(limitGroup)},'INC-BIZ','INC',1,
      'CI-only cohort limit','Synthetic report fixture','{}','INDIVIDUAL','LOW','P3','CLOSED','2024-01-02 10:00:00+08'
    FROM generate_series(1,5000) n`);
const bounded = await request(`/reports/summary${limitWindow}`, 'agent-1');
assert.equal(bounded.status, 200, JSON.stringify(bounded));
assert.equal(bounded.data.metrics.tickets, 0);
assert.equal(bounded.data.responsibility[0].metrics.tickets, 5000);
await sql(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
    subject,description,fields,impact,urgency,priority,status,created_at)
  SELECT gen_random_uuid(),${quote(`${limitGroup}-5001`)},requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
    subject,description,fields,impact,urgency,priority,status,created_at FROM tickets WHERE owner_group_id=${quote(limitGroup)} LIMIT 1`);
const oversized = await request(`/reports/summary${limitWindow}`, 'agent-1');
assert.equal(oversized.status, 503, JSON.stringify(oversized));
assert.equal(oversized.data.code, 'REPORT_WINDOW_TOO_LARGE', 'filters cannot hide a truncated full group cohort');
await assert.rejects(sql(`UPDATE support_groups SET enabled=false WHERE id=${quote(limitGroup)}`), /SUPPORT_GROUP_DEPENDENCIES/);
await retireSupportGroup(limitGroup);
assert.equal((await request(`/reports/summary${limitWindow}`, 'agent-1')).status, 404);
console.log('Reports verified: scoped INC/REQ, service and current-owner filters, catalog rename/unpublish, accepted-only group handovers, full-cohort limits, inactive groups, whole-ticket SLA and feedback');
