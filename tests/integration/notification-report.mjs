import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNotificationReportFixture } from '../support/notification-report.mjs';
import { createFulfillmentFixture, fulfillmentSql as sql, literal as q } from '../support/fulfillment.mjs';
import { retireSupportGroup } from '../support/support-groups.mjs';

if (process.env.GITHUB_ACTIONS!=='true' || !process.env.ITSM_CI_ENV
  || process.env.ITSM_NOTIFICATION_REPORT_WORKER_STOPPED!=='true') throw new Error('STOPPED_DISPOSABLE_CI_WORKER_ONLY');
const base='http://127.0.0.1:8088/api/v1';
const fixture=await createNotificationReportFixture({unexpanded:true});
const viewer=`notice-report-${randomUUID()}`;
await sql(`INSERT INTO employees(id,display_name) VALUES(${q(viewer)},'Report viewer');
  INSERT INTO group_memberships(employee_id,group_id) VALUES(${q(viewer)},${q(fixture.groupId)})`);
async function report(group=fixture.groupId, extra='&serviceType=REQ', user=viewer, day=fixture.day) {
  const response=await fetch(`${base}/reports/notifications?groupId=${encodeURIComponent(group)}&from=${day}&to=${day}${extra}`,
    {headers:{'X-Dev-User':user},signal:AbortSignal.timeout(20000)});
  return {status:response.status,data:await response.json()};
}
let result=await report();
assert.equal(result.status,200,JSON.stringify(result));
assert.equal(result.data.attribution,'CURRENT_OWNER_GROUP');
assert.equal(result.data.windowBasis,'OUTBOX_CREATED_AT');
assert.equal(result.data.timeZone,'Asia/Shanghai');
assert.deepEqual(result.data.coverage,{events:3,unexpandedEvents:1,expandedWithoutDeliveryEvents:1});
assert.equal(result.data.cohortMetrics.deliveries,11);
assert.equal(result.data.cohortMetrics.tickets,1);
assert.equal(result.data.metrics.attention,5);
assert.equal(result.data.metrics.states.DELIVERED,1);
assert.equal(result.data.metrics.states.SIMULATED,1);
assert.equal(result.data.metrics.states.SKIPPED,1);
assert.equal(result.data.metrics.states.OTHER,1);
assert.equal(result.data.metrics.states.PENDING,2);
assert.equal(result.data.metrics.states.SENDING,2);
assert.equal(result.data.metrics.states.DISPATCHING,1);
assert.equal(result.data.metrics.reasons.find(reason=>reason.code==='OTHER')?.count,1);
assert.ok(result.data.items.every(item=>Date.parse(item.eventAt)>=Date.parse(`${fixture.day}T00:00:00+08:00`)
  && Date.parse(item.eventAt)<Date.parse(`${fixture.day}T00:00:00+08:00`)+86400000));
assert.ok(result.data.items.every(item=>Date.parse(item.updatedAt)>Date.parse(`${fixture.day}T23:59:59+08:00`)),
  'cohort is based on event day, not latest delivery update');
for(const secret of [fixture.marker,'PRIVATE_STATE',fixture.deliveries[0].employee,'provider_task_id','provider_recipient_hash',
  'employeeId','payload','last_error']) assert.equal(JSON.stringify(result.data).includes(secret),false,secret);
const attention=await report(fixture.groupId,'&serviceType=REQ&state=ATTENTION');
assert.equal(attention.data.items.length,5);
assert.equal(attention.data.cohortMetrics.deliveries,11);
assert.deepEqual(attention.data.coverage,result.data.coverage);
const dead=await report(fixture.groupId,'&serviceType=REQ&state=DEAD');
assert.equal(dead.data.metrics.deliveries,1); assert.equal(dead.data.metrics.attention,1);
assert.equal(dead.data.items[0].reason,'TOKEN_FAILED');
const unknown=await report(fixture.groupId,'&serviceType=REQ&state=OTHER');
assert.equal(unknown.data.items.length,1); assert.equal(unknown.data.items[0].reason,'OTHER');
assert.deepEqual((await report(fixture.groupId,'')).data.items,[],'default INC does not include REQ');
assert.equal((await report(fixture.groupId,'&serviceType=REQ','employee-1')).status,404);
await assert.rejects(sql(`UPDATE support_groups SET enabled=false WHERE id=${q(fixture.groupId)}`), /SUPPORT_GROUP_DEPENDENCIES/);
assert.equal((await report()).status,200,'active dependencies prevent retirement without removing report access');
for(const extra of ['&serviceType=ALL','&serviceType=REQ&serviceType=INC','&state=unknown','&state=DEAD&state=PENDING'])
  assert.equal((await report(fixture.groupId,extra)).status,400,extra);
assert.equal((await report(fixture.groupId,'&serviceType=REQ',viewer,'2025-02-30')).status,400);
for(const range of ['from=2025-07-01&to=2025-06-01','from=2025-06-01&to=2025-07-02']) {
  const invalid=await fetch(`${base}/reports/notifications?groupId=${fixture.groupId}&${range}`,
    {headers:{'X-Dev-User':viewer}}); assert.equal(invalid.status,400);
}
const target=await createFulfillmentFixture({state:null});
assert.equal((await report(target.groupId)).status,404);
await sql(`UPDATE tickets SET owner_group_id=${q(target.groupId)} WHERE id=${q(fixture.ticketId)}`);
assert.deepEqual((await report()).data.items,[],'old group loses current-owner statistics after transfer');
const destination=await report(target.groupId,'&serviceType=REQ','agent-1');
assert.equal(destination.data.metrics.deliveries,11);
assert.equal(JSON.stringify(destination.data).includes(fixture.marker),false);
await sql(`UPDATE service_catalog SET published=false WHERE code=${q(fixture.serviceCode)}`);
await retireSupportGroup(fixture.groupId);
assert.equal((await report()).status,404,'reviewed retirement removes the former reporting scope');

// Exhaust the full authorized cohort before filtering: no partial totals, even when DEAD has no matches.
const crowded=await createFulfillmentFixture({state:null});
const eventId=randomUUID(), outboxId=randomUUID(), prefix=`notice-limit-${randomUUID()}-`;
await sql(`INSERT INTO group_memberships(employee_id,group_id) VALUES(${q(viewer)},${q(crowded.groupId)});
  INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,request_id,created_at)
    VALUES(${q(eventId)},${q(crowded.ticketId)},'system','CI_REPORT','IN_PROGRESS',${q(prefix)},${q(`${fixture.day} 12:00:00+08`)});
  INSERT INTO outbox_events(id,ticket_id,event_id,kind,payload,created_at,expanded_at)
    VALUES(${q(outboxId)},${q(crowded.ticketId)},${q(eventId)},'CI_REPORT','{}',${q(`${fixture.day} 12:00:00+08`)},now());
  INSERT INTO employees(id,display_name) SELECT ${q(prefix)}||n,'CI limit recipient' FROM generate_series(1,5001) n;
  INSERT INTO notification_deliveries(outbox_id,employee_id,state,next_at)
    SELECT ${q(outboxId)},${q(prefix)}||n,'PENDING',now()+interval '1 day' FROM generate_series(1,5001) n`);
for(const filter of ['','&state=DEAD']) {
  const limited=await report(crowded.groupId,`&serviceType=REQ${filter}`);
  assert.equal(limited.status,503); assert.equal(limited.data.code,'REPORT_NOTIFICATION_WINDOW_TOO_LARGE');
  assert.equal(limited.data.items,undefined);
}
await sql(`DELETE FROM group_memberships WHERE employee_id=${q(viewer)}`);
assert.equal((await report()).status,404);
await sql(`UPDATE employees SET active=false WHERE id=${q(viewer)}`);
assert.equal((await report()).status,401);
console.log('Notification reports verified: scoped event cohorts, real/simulated separation, uncertainty, retry and skipped states, safe errors, transfer, date boundaries and explicit limits');
