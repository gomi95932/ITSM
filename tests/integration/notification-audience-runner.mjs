import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expandNotification, notificationRecipients } from './apps/worker/dist/notification-audience.js';

if (process.env.ITSM_NOTIFICATION_CI !== 'true' || process.env.NODE_ENV === 'production') throw new Error('DISPOSABLE_NOTIFICATION_CI_ONLY');
const db = new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD});
const client = await db.connect();
const prefix = `notify-${randomUUID()}`;
const apiOrigin = 'http://api:3000';
const id = name => `${prefix}-${name}`;
const people = ['requester','owner','peer','dispatcher','lead','admin','reviewer','candidate','other-candidate',
  'expired','future','revoked','disabled','proposer','approver'];
let ticket;
async function setup() {
  for (const person of people) await client.query('INSERT INTO employees(id,display_name,active) VALUES ($1,$2,$3)',
    [id(person),`Notification CI ${person}`,person!=='disabled']);
  for (const group of ['group','target']) await client.query('INSERT INTO support_groups(id,name) VALUES ($1,$2)',[id(group),id(group)]);
  for (const person of people.filter(p=>!['requester','proposer','approver','candidate','other-candidate'].includes(p)))
    await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES ($1,$2)',[id(person),id('group')]);
  for (const person of ['candidate','other-candidate'])
    await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES ($1,$2)',[id(person),id('target')]);
  for (const person of ['dispatcher','lead','expired','future','revoked','disabled','admin']) {
    const role = person==='admin'?'PLATFORM_ADMIN':person==='lead'?'GROUP_LEAD':'DISPATCHER';
    const start = person==='future'?3600:-7200;
    const end = person==='expired'?-3600:86400;
    await client.query(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,requested_by,reviewed_by,reason)
      VALUES ($1,$2,$3,$4,now()+$5*interval '1 second',now()+$6*interval '1 second',$7,$8,$9,'Disposable notification CI')`,
      [randomUUID(),id(person),role,role==='PLATFORM_ADMIN'?null:id('group'),start,end,person==='revoked'?'REVOKED':'ACTIVE',id('proposer'),id('approver')]);
  }
  await client.query('INSERT INTO priority_reviewers(employee_id,group_id) VALUES ($1,$2)',[id('reviewer'),id('group')]);
  await client.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id) VALUES ($1,'INC',1,true,$2)`,[id('catalog'),id('group')]);
  ticket = randomUUID();
  await client.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
    subject,description,fields,impact,urgency,priority,status) VALUES ($1,$2,$3,$3,$4,$5,'INC',1,'Notification fixture',
    'Disposable CI only','{}','INDIVIDUAL','LOW','P4','OPEN')`,[ticket,id('number'),id('requester'),id('group'),id('catalog')]);
}
async function event(action,detail={}) {
  const eventId=randomUUID(),outboxId=randomUUID();
  await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,detail,request_id)
    VALUES ($1,$2,$3,$4,'OPEN',$5,$6)`,[eventId,ticket,id('owner'),action,JSON.stringify(detail),randomUUID()]);
  await client.query(`INSERT INTO outbox_events(id,ticket_id,event_id,kind,payload,expanded_at,state)
    VALUES ($1,$2,$3,'TICKET_CHANGED','{}',now(),'EXPANDED')`,[outboxId,ticket,eventId]);
  return {eventId,outboxId};
}
async function audience(action,expected,detail={}) {
  const e=await event(action,detail);
  assert.deepEqual(await notificationRecipients(client,e.eventId),expected.map(id).sort(),action);
  return e;
}
async function retry(deliveryId,user) {
  const response=await fetch(new URL(`/api/v1/notifications/${deliveryId}/retry`,apiOrigin),{
    method:'POST',headers:{'Content-Type':'application/json','X-Dev-User':id(user)},body:'{}'});
  return response.status;
}
async function canRetry(deliveryId,user) {
  const response=await fetch(new URL('/api/v1/notifications',apiOrigin),{headers:{'X-Dev-User':id(user)}});
  assert.equal(response.status,200);
  const delivery=(await response.json()).items.find(item=>item.id===deliveryId);
  assert.ok(delivery,'current-group delivery visible');
  return delivery.canRetry;
}
try {
  const existingAdmins = (await client.query(`SELECT DISTINCT e.id FROM employees e JOIN role_bindings r ON r.employee_id=e.id
    WHERE e.active AND r.role_code='PLATFORM_ADMIN' AND r.status='ACTIVE'
      AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp()`)).rows.map(row=>row.id);
  // Uncommitted audience fixtures are invisible to the concurrent notification worker.
  await client.query('BEGIN');
  await setup();
  await audience('SUBMIT_AND_ROUTE',['requester','dispatcher','lead']);
  await client.query('UPDATE tickets SET assignee_id=$2 WHERE id=$1',[ticket,id('owner')]);
  const accepted=await audience('ACCEPT',['requester','owner']);
  await audience('WAIT_VENDOR',['owner']);
  await audience('P1_CANDIDATE',['owner','dispatcher','lead','reviewer']);
  await audience('SLA_BREACH',['owner','dispatcher','lead']);
  await audience('INTERNAL_COMMENT',[]);
  await client.query("UPDATE tickets SET pending_group_id=$2,pending_assignee_id=$3,assignment_kind='HANDOVER',assignment_state='PENDING',assignment_offered_at=now() WHERE id=$1",[ticket,id('target'),id('candidate')]);
  const handover=await audience('REASSIGN',['owner','candidate'],{targetGroupId:id('target'),targetAssigneeId:id('candidate'),assignmentVersion:1});
  await client.query('UPDATE tickets SET pending_assignee_id=$2 WHERE id=$1',[ticket,id('other-candidate')]);
  assert.deepEqual(await notificationRecipients(client,handover.eventId),[id('owner')],'stale handover cannot notify a replacement candidate');
  await client.query('UPDATE tickets SET pending_assignee_id=$2,version=version+1 WHERE id=$1',[ticket,id('candidate')]);
  assert.deepEqual(await notificationRecipients(client,handover.eventId),[id('owner')],'old offer cannot notify the same candidate on a later assignment');
  await expandNotification(client,accepted.outboxId,accepted.eventId);
  await expandNotification(client,accepted.outboxId,accepted.eventId);
  assert.equal((await client.query('SELECT count(*) FROM notification_deliveries WHERE outbox_id=$1',[accepted.outboxId])).rows[0].count,'2');
  await client.query('DELETE FROM group_memberships WHERE employee_id=$1 AND group_id=$2',[id('owner'),id('group')]);
  assert.deepEqual(await notificationRecipients(client,accepted.eventId,id('owner')),[],'membership revoked after expansion');
  await client.query('UPDATE employees SET active=false WHERE id=$1',[id('requester')]);
  assert.deepEqual(await notificationRecipients(client,accepted.eventId,id('requester')),[],'disabled requester after expansion');
  await client.query("UPDATE tickets SET assignee_id=NULL,pending_group_id=NULL,pending_assignee_id=NULL,assignment_kind=NULL,assignment_state='CANCELLED',assignment_offered_at=NULL WHERE id=$1",[ticket]);
  const queue=await event('SUBMIT_AND_ROUTE');
  await expandNotification(client,queue.outboxId,queue.eventId);
  await client.query("UPDATE role_bindings SET status='REVOKED' WHERE employee_id=$1",[id('dispatcher')]);
  assert.deepEqual(await notificationRecipients(client,queue.eventId,id('dispatcher')),[],'role revoked after expansion');
  await client.query("UPDATE role_bindings SET valid_from=now()-interval '2 hours',valid_to=now()-interval '1 hour' WHERE employee_id=$1",[id('lead')]);
  assert.deepEqual(await notificationRecipients(client,queue.eventId,id('lead')),[],'role expired after expansion');
  await client.query('DELETE FROM group_memberships WHERE group_id=$1',[id('group')]);
  const stranded=await event('OWNERSHIP_ESCALATION_REQUIRED');
  assert.deepEqual(await notificationRecipients(client,stranded.eventId),[...existingAdmins,id('admin')].sort(),
    'routing escalation reaches every active platform administrator');
  await client.query("UPDATE role_bindings SET status='REVOKED' WHERE employee_id=$1",[id('admin')]);
  assert.deepEqual(await notificationRecipients(client,stranded.eventId,id('admin')),[],'revoked administrator cannot receive an already expanded routing alert');
  await client.query('ROLLBACK');

  // Retry authorization must be exercised through a different API connection.
  await client.query('BEGIN');
  await setup();
  const retryEvent=await event('ACCEPT');
  const delivery=randomUUID();
  await client.query(`INSERT INTO notification_deliveries(id,outbox_id,employee_id,state,next_at)
    VALUES ($1,$2,$3,'DEAD',now()+interval '1 day')`,[delivery,retryEvent.outboxId,id('requester')]);
  await client.query('COMMIT');
  for (const person of ['peer','owner','admin','reviewer','expired','future','revoked'])
    assert.equal(await canRetry(delivery,person),false,`${person} sees no retry command`);
  assert.equal(await canRetry(delivery,'dispatcher'),true);
  assert.equal(await canRetry(delivery,'lead'),true);
  await db.query("UPDATE notification_deliveries SET state='REVIEW_REQUIRED' WHERE id=$1",[delivery]);
  assert.equal(await canRetry(delivery,'lead'),false,'an uncertain send cannot be retried');
  assert.equal(await retry(delivery,'lead'),404,'retry endpoint must reject an uncertain send');
  await db.query("UPDATE notification_deliveries SET state='DEAD' WHERE id=$1",[delivery]);
  for (const person of ['peer','owner','admin','reviewer','candidate','expired','future','revoked'])
    assert.equal(await retry(delivery,person),404,`${person} cannot retry`);
  assert.equal((await db.query('SELECT state FROM notification_deliveries WHERE id=$1',[delivery])).rows[0].state,'DEAD');
  assert.equal(await retry(delivery,'dispatcher'),200,'current scoped dispatcher can retry');
  assert.equal((await db.query("SELECT count(*) FROM operational_audits WHERE action='NOTIFICATION_RETRY' AND target_id=$1",[delivery])).rows[0].count,'1');
  await db.query("UPDATE notification_deliveries SET state='DEAD',next_at=now()+interval '1 day' WHERE id=$1",[delivery]);
  await db.query("UPDATE role_bindings SET status='REVOKED' WHERE employee_id=$1",[id('dispatcher')]);
  assert.equal(await canRetry(delivery,'dispatcher'),false,'revocation removes the retry command');
  assert.equal(await retry(delivery,'dispatcher'),404,'retry rechecks revoked role');
  assert.equal(await retry(delivery,'disabled'),401,'disabled employee cannot retry');
  assert.equal(await retry(delivery,'lead'),200,'current scoped group lead can retry');
  assert.equal((await db.query("SELECT count(*) FROM operational_audits WHERE action='NOTIFICATION_RETRY' AND target_id=$1",[delivery])).rows[0].count,'2');
  await db.query("UPDATE notification_deliveries SET state='DEAD',next_at=now()+interval '1 day' WHERE id=$1",[delivery]);
  await db.query('DELETE FROM group_memberships WHERE employee_id=$1 AND group_id=$2',[id('lead'),id('group')]);
  assert.equal(await retry(delivery,'lead'),404,'removed member cannot use an existing role');
  assert.equal((await db.query('SELECT state FROM notification_deliveries WHERE id=$1',[delivery])).rows[0].state,'DEAD');
  console.log('Notification audience verified: targeted events, stale handovers, idempotent expansion, live revocation and scoped audited retries');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await db.end();
}
