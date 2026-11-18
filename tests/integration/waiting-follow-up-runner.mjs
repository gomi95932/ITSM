import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DEFAULT_CALENDAR } from '@itsm/contracts';
import { maintainWaitingFollowUps } from './apps/worker/dist/waiting-follow-up.js';
import { notificationRecipients,expandNotification,refreshWaitingNotificationAudiences } from './apps/worker/dist/notification-audience.js';
import { deliverNotification } from './apps/worker/dist/notification-delivery.js';

if(process.env.ITSM_WAITING_CI!=='true'||process.env.NODE_ENV==='production'
  ||process.env.ENABLE_LIVE_NOTIFICATIONS==='true')throw new Error('DISPOSABLE_WAITING_CI_ONLY');
const db=new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,max:5});
const prefix=`waiting-${randomUUID()}`,group=`${prefix}-group`,other=`${prefix}-other`;
const person=role=>`${prefix}-${role}`,position=`${prefix}-position`,domain=`${prefix}-domain`;
const roles=['requester','owner','peer','lead','other-lead','dispatcher','outsider'];
const routing={primaryPositionId:position,positions:[{id:position,groupId:group}]};
const sorted=(...names)=>names.map(person).sort();

async function fixture(client,{status='WAITING_USER',dueMinutes=-60,legacy=false,route=routing}={}){
  const ticket=randomUUID(),reason=status==='WAITING_USER'?'USER_INFORMATION':'VENDOR_SUPPORT';
  await client.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,assignee_id,
    service_code,service_type,form_version,subject,description,fields,impact,urgency,priority,status,
    service_routing_snapshot,waiting_reason_code,waiting_since,waiting_due_at)
    VALUES($1::uuid,$1::text,$2,$2,$3,$4,$5,'INC',1,'Waiting reminder','CI only','{}','INDIVIDUAL','LOW','P4',$6,$7,
      CASE WHEN NOT $8 THEN $9 END,CASE WHEN NOT $8 THEN clock_timestamp()-interval '2 hours' END,
      CASE WHEN NOT $8 THEN clock_timestamp()+$10*interval '1 minute' END)`,
  [ticket,person('requester'),group,person('owner'),prefix,status,JSON.stringify(route),legacy,reason,dueMinutes]);
  await client.query(`INSERT INTO sla_cycles(ticket_id,cycle,priority,calendar_snapshot,started_at,response_target,
    resolution_target,paused_at) VALUES($1,1,'P4',$2,now()-interval '3 hours',540,2700,
      CASE WHEN $3='WAITING_USER' THEN now()-interval '2 hours' END)`,[ticket,JSON.stringify(DEFAULT_CALENDAR),status]);
  return ticket;
}
async function signals(client,ticket){
  return (await client.query(`SELECT s.*,o.id AS outbox_id FROM ticket_waiting_signals s
    JOIN outbox_events o ON o.event_id=s.event_id WHERE s.ticket_id=$1 ORDER BY s.created_at,s.event_id`,[ticket])).rows;
}
async function snapshot(client,ticket){
  return (await client.query(`SELECT jsonb_build_object('ticket',to_jsonb(t),'sla',(SELECT jsonb_agg(to_jsonb(c))
    FROM sla_cycles c WHERE c.ticket_id=t.id),'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY h.revision)
    FROM ticket_responsibility_history h WHERE h.ticket_id=t.id)) AS value FROM tickets t WHERE t.id=$1`,[ticket])).rows[0].value;
}
async function expectFailure(client,action,pattern){
  await client.query('SAVEPOINT expected_failure');
  try{await assert.rejects(action,pattern);}finally{await client.query('ROLLBACK TO SAVEPOINT expected_failure');}
}
async function configureAppointments(client,change){
  const config=structuredClone((await client.query(`SELECT v.config FROM service_structure_current c
    JOIN service_structure_versions v ON v.version=c.version WHERE c.id`)).rows[0].config);
  change(config.appointments);
  await client.query(`INSERT INTO service_structure_versions(version,config)
    SELECT version+1,$1 FROM service_structure_current WHERE id`,[JSON.stringify(config)]);
  await client.query('UPDATE service_structure_current SET version=version+1 WHERE id');
}

// Keep all business SQL real, scope scans to disposable fixtures, and nest worker transactions in the test transaction.
function isolatedPool(client,{failOutbox=false,failDeliveryAt=0,audienceIds=null}={}){
  let deliveries=0;
  return {async connect(){return {
    async query(text,params){
      if(text==='BEGIN')return client.query('SAVEPOINT waiting_scan');
      if(text==='COMMIT')return client.query('RELEASE SAVEPOINT waiting_scan');
      if(text==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT waiting_scan');
      if(failOutbox&&text.includes('INSERT INTO outbox_events'))throw new Error('CI_OUTBOX_FAILURE');
      if(text.includes('INSERT INTO notification_deliveries')&&++deliveries===failDeliveryAt)throw new Error('CI_DELIVERY_FAILURE');
      if(text.startsWith('SELECT t.id,t.owner_group_id,t.status,t.version,'))
        return client.query(text.replace('WHERE t.status IN','WHERE t.owner_group_id IN ($1,$2) AND t.status IN'),[group,other]);
      if(text.startsWith('SELECT o.id,o.event_id FROM outbox_events o'))
        return client.query(text.replace('WHERE o.expanded_at IS NOT NULL',
          `WHERE s.group_id IN ($1,$2) ${audienceIds?'AND o.id=ANY($3::uuid[]) ':''}AND o.expanded_at IS NOT NULL`),
        audienceIds?[group,other,audienceIds]:[group,other]);
      return client.query(text,params);
    },release(){},
  };}};
}
async function isolatedDelivery(client,deliveryId,{beforeTransaction,provider,mode='fake'}={}){
  let sequence=0;
  return deliverNotification({mode,production:false,live:mode==='dingtalk',corpId:prefix,agentId:'123',
    publicUrl:'https://itsm.example.test/',provider:provider??(async()=>{throw new Error('PROVIDER_MUST_NOT_RUN');}),
    async transaction(fn){
      await client.query('SAVEPOINT waiting_delivery');
      try{
        await beforeTransaction?.(++sequence);
        const scoped={async query(text,params){
          return text.includes('WHERE d.state IN')
            ?client.query(text.replace('WHERE d.state IN','WHERE d.id=$1 AND d.state IN'),[deliveryId])
            :client.query(text,params);
        }};
        const result=await fn(scoped);
        await client.query('RELEASE SAVEPOINT waiting_delivery');
        return result;
      }catch(error){await client.query('ROLLBACK TO SAVEPOINT waiting_delivery');throw error;}
    },
  });
}

let client;
try{
  client=await db.connect();await client.query('BEGIN');
  for(const role of roles){
    await client.query('INSERT INTO employees(id,display_name) VALUES($1,$2)',[person(role),`CI ${role}`]);
    await client.query('INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES($1,$2,$2)',[prefix,person(role)]);
  }
  await client.query('INSERT INTO support_groups(id,name) VALUES($1,$1),($2,$2)',[group,other]);
  for(const role of roles.filter(role=>role!=='requester'))
    await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES($1,$2)',
      [person(role),['outsider','other-lead'].includes(role)?other:group]);
  for(const role of ['lead','other-lead','dispatcher'])await client.query(`INSERT INTO role_bindings(id,employee_id,
    role_code,group_id,valid_from,valid_to,status,requested_by,reviewed_by,reason)
    VALUES($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day','ACTIVE',$5,$6,'CI independent role review')`,
  [randomUUID(),person(role),role==='dispatcher'?'DISPATCHER':'GROUP_LEAD',role==='other-lead'?other:group,
    person('requester'),person('outsider')]);
  await client.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id,name)
    VALUES($1,'INC',1,true,$2,'CI waiting')`,[prefix,group]);
  await client.query('SELECT pg_advisory_xact_lock(71820512)');
  await client.query('SELECT version FROM service_structure_current WHERE id FOR UPDATE');
  await client.query(`INSERT INTO service_structure_versions(version,config)
    SELECT v.version+1,jsonb_build_object('domains',(v.config->'domains')||$1::jsonb,'systems',v.config->'systems',
      'positions',(v.config->'positions')||$2::jsonb,'appointments',(v.config->'appointments')||$3::jsonb,'mappings',v.config->'mappings')
    FROM service_structure_current c JOIN service_structure_versions v ON v.version=c.version WHERE c.id`,
  [JSON.stringify([{id:domain,name:'CI waiting',enabled:true}]),
    JSON.stringify([{id:position,name:'CI follow-up engineer',domainId:domain,groupId:group,enabled:true}]),
    JSON.stringify(['owner','peer'].map(role=>({id:randomUUID(),positionId:position,employeeId:person(role),duty:'PRIMARY',
      enabled:true,validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString()})))]);
  await client.query('UPDATE service_structure_current SET version=version+1 WHERE id');
  const pool=isolatedPool(client);

  const user=await fixture(client),vendor=await fixture(client,{status:'WAITING_VENDOR'});
  const future=await fixture(client,{dueMinutes:60}),legacy=await fixture(client,{legacy:true});
  const before=await snapshot(client,user),vendorBefore=await snapshot(client,vendor);
  await maintainWaitingFollowUps(pool);await maintainWaitingFollowUps(pool);
  const [userSignal]=await signals(client,user),[vendorSignal]=await signals(client,vendor);
  assert.equal((await signals(client,user)).length,1,'polling does not duplicate a waiting episode');
  assert.equal((await signals(client,future)).length,0,'future waits are not due');
  assert.equal((await signals(client,legacy)).length,0,'unknown legacy metadata cannot invent deadlines');
  assert.deepEqual(await snapshot(client,user),before,'reminders change neither the ticket, SLA nor responsibility history');
  assert.deepEqual(await snapshot(client,vendor),vendorBefore,'vendor SLA never pauses on reminder');
  for(const signal of [userSignal,vendorSignal]){
    assert.equal((await client.query(`SELECT s.waiting_since=t.waiting_since AND s.waiting_due_at=t.waiting_due_at AS exact
      FROM ticket_waiting_signals s JOIN tickets t ON t.id=s.ticket_id WHERE s.event_id=$1`,[signal.event_id])).rows[0].exact,true,
    'deduplication timestamps retain PostgreSQL precision');
    for(const table of ['ticket_events','audit_logs','outbox_events'])
      assert.equal((await client.query(`SELECT count(*) FROM ${table} WHERE ${table==='ticket_events'?'id':'event_id'}=$1`,
        [signal.event_id])).rows[0].count,'1');
  }
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),sorted('owner','requester'));
  assert.deepEqual(await notificationRecipients(client,vendorSignal.event_id),sorted('owner'));
  assert.deepEqual(await notificationRecipients(client,vendorSignal.event_id,person('requester')),[]);
  await expandNotification(client,userSignal.outbox_id,userSignal.event_id);
  await expandNotification(client,userSignal.outbox_id,userSignal.event_id);
  assert.equal((await client.query('SELECT count(*) FROM notification_deliveries WHERE outbox_id=$1',
    [userSignal.outbox_id])).rows[0].count,'2','expansion targets only requester and actual owner');
  for(const mutation of ['UPDATE ticket_waiting_signals SET waiting_due_at=now()',
    'DELETE FROM ticket_waiting_signals','TRUNCATE ticket_waiting_signals'])
    await expectFailure(client,()=>client.query(mutation),/REQUEST_CATALOG_VERSION_IMMUTABLE/);

  const forged=randomUUID();
  await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,request_id)
    VALUES($1,$2,'system:scheduler','WAITING_USER_FOLLOW_UP_DUE','WAITING_USER',$3)`,[forged,user,randomUUID()]);
  assert.deepEqual(await notificationRecipients(client,forged),[],'an action name alone is not reminder authorization');

  await client.query('SAVEPOINT qualification');
  await configureAppointments(client,appointments=>{appointments.find(a=>a.employeeId===person('owner')).enabled=false;});
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),sorted('lead','requester'),
    'withdrawn owner appointment falls back to current group lead, never all peers or dispatchers');
  await client.query("UPDATE role_bindings SET status='REVOKED' WHERE employee_id=$1",[person('lead')]);
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),sorted('requester'));
  await client.query('ROLLBACK TO SAVEPOINT qualification');
  await client.query('SAVEPOINT qualification');
  await client.query('UPDATE employees SET active=false WHERE id=$1',[person('owner')]);
  assert.deepEqual(await notificationRecipients(client,vendorSignal.event_id),sorted('lead'),'departed owner cannot receive');
  await client.query('DELETE FROM group_memberships WHERE group_id=$1 AND employee_id=$2',[group,person('lead')]);
  assert.deepEqual(await notificationRecipients(client,vendorSignal.event_id),[],'a stale lead role without membership cannot receive');
  await client.query('ROLLBACK TO SAVEPOINT qualification');
  await client.query('SAVEPOINT qualification');
  await client.query('DELETE FROM group_memberships WHERE group_id=$1 AND employee_id=$2',[group,person('owner')]);
  assert.deepEqual(await notificationRecipients(client,vendorSignal.event_id),sorted('lead'));
  await client.query("UPDATE role_bindings SET valid_to=now()-interval '1 hour' WHERE employee_id=$1",[person('lead')]);
  assert.deepEqual(await notificationRecipients(client,vendorSignal.event_id),[],'expired lead cannot receive');
  await client.query('ROLLBACK TO SAVEPOINT qualification');
  await client.query('SAVEPOINT qualification');
  await client.query('UPDATE employees SET active=false WHERE id=$1',[person('requester')]);
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),sorted('owner'));
  await client.query('ROLLBACK TO SAVEPOINT qualification');

  await client.query('SAVEPOINT handed_over');
  await client.query(`UPDATE tickets SET pending_group_id=$2,pending_assignee_id=$3,assignment_kind='HANDOVER',
    assignment_state='PENDING',assignment_offered_at=now() WHERE id=$1`,[user,group,person('peer')]);
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),sorted('owner','requester'),'candidate is not yet responsible');
  await client.query(`UPDATE tickets SET assignee_id=$2,pending_group_id=NULL,pending_assignee_id=NULL,
    assignment_kind=NULL,assignment_state='ACCEPTED',assignment_offered_at=NULL WHERE id=$1`,[user,person('peer')]);
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),sorted('peer','requester'));
  const oldDelivery=(await client.query('SELECT id FROM notification_deliveries WHERE outbox_id=$1 AND employee_id=$2',
    [userSignal.outbox_id,person('owner')])).rows[0].id;
  await isolatedDelivery(client,oldDelivery);
  assert.equal((await client.query('SELECT state FROM notification_deliveries WHERE id=$1',[oldDelivery])).rows[0].state,'SKIPPED',
    'dispatch rechecks the current assignee after expansion');
  await client.query('UPDATE outbox_events SET audience_checked_at=NULL WHERE id=$1',[userSignal.outbox_id]);
  await refreshWaitingNotificationAudiences(isolatedPool(client,{audienceIds:[userSignal.outbox_id]}));
  assert.deepEqual((await client.query('SELECT employee_id FROM notification_deliveries WHERE outbox_id=$1 ORDER BY employee_id',
    [userSignal.outbox_id])).rows.map(r=>r.employee_id),sorted('owner','peer','requester'));
  assert.equal((await client.query('SELECT state FROM notification_deliveries WHERE id=$1',[oldDelivery])).rows[0].state,'SKIPPED',
    'audience refresh does not resurrect skipped deliveries');
  await client.query(`UPDATE tickets SET owner_group_id=$2,assignee_id=$3,service_routing_snapshot='{}' WHERE id=$1`,
    [user,other,person('outsider')]);
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),[],'old-group signal immediately loses authorization');
  await maintainWaitingFollowUps(pool);
  const moved=(await signals(client,user)).find(s=>s.group_id===other);
  assert.ok(moved);assert.deepEqual(await notificationRecipients(client,moved.event_id),sorted('outsider','requester'));
  await client.query('ROLLBACK TO SAVEPOINT handed_over');

  await client.query('SAVEPOINT changed_deadline');
  await client.query("UPDATE tickets SET waiting_due_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[user]);
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),[],'rescheduled deadlines suppress unsent reminders');
  await maintainWaitingFollowUps(pool);assert.equal((await signals(client,user)).length,1);
  await client.query("UPDATE tickets SET waiting_due_at=clock_timestamp()-interval '30 minutes' WHERE id=$1",[user]);
  await maintainWaitingFollowUps(pool);assert.equal((await signals(client,user)).length,2,'a new due deadline gets its own signal');
  await client.query("UPDATE tickets SET status='IN_PROGRESS' WHERE id=$1",[user]);
  assert.deepEqual(await notificationRecipients(client,userSignal.event_id),[],'fulfilled information request stops reminders');
  await client.query('ROLLBACK TO SAVEPOINT changed_deadline');

  const requesterDelivery=(await client.query('SELECT id FROM notification_deliveries WHERE outbox_id=$1 AND employee_id=$2',
    [userSignal.outbox_id,person('requester')])).rows[0].id;
  let providerCalls=0;
  const provider=async operation=>{
    providerCalls++;
    return operation==='asyncsend_v2'?{task_id:'12345'}:{send_result:{unread_user_id_list:[person('requester')]}};
  };
  await isolatedDelivery(client,requesterDelivery,{mode:'dingtalk',provider});
  await client.query("UPDATE notification_deliveries SET next_at='-infinity' WHERE id=$1",[requesterDelivery]);
  await isolatedDelivery(client,requesterDelivery,{mode:'dingtalk',provider});
  assert.equal(providerCalls,2,'isolated provider stub exercises send and confirmed receipt, not live DingTalk');
  assert.equal((await client.query('SELECT state FROM notification_deliveries WHERE id=$1',[requesterDelivery])).rows[0].state,'DELIVERED');
  assert.equal((await client.query('SELECT responded_at FROM sla_cycles WHERE ticket_id=$1',[user])).rows[0].responded_at,null,
    'even confirmed reminder receipt is not first-response evidence');
  await expandNotification(client,vendorSignal.outbox_id,vendorSignal.event_id);
  const vendorDelivery=(await client.query('SELECT id FROM notification_deliveries WHERE outbox_id=$1',[vendorSignal.outbox_id])).rows[0].id;
  await client.query('SAVEPOINT pre_send_change');
  await isolatedDelivery(client,vendorDelivery,{mode:'dingtalk',provider,beforeTransaction:async sequence=>{
    if(sequence===2)await client.query('UPDATE employees SET active=false WHERE id=$1',[person('owner')]);
  }});
  assert.equal(providerCalls,2,'revocation between checkpoint and send prevents the provider call');
  assert.equal((await client.query('SELECT state FROM notification_deliveries WHERE id=$1',[vendorDelivery])).rows[0].state,'SKIPPED');
  await client.query('ROLLBACK TO SAVEPOINT pre_send_change');

  const rollbackTicket=await fixture(client);
  await assert.rejects(maintainWaitingFollowUps(isolatedPool(client,{failOutbox:true})),/CI_OUTBOX_FAILURE/);
  assert.equal((await signals(client,rollbackTicket)).length,0);
  for(const table of ['ticket_events','audit_logs','outbox_events'])
    assert.equal((await client.query(`SELECT count(*) FROM ${table} WHERE ticket_id=$1`,[rollbackTicket])).rows[0].count,'0',
      'failed outbox write rolls back every earlier waiting write');
  await maintainWaitingFollowUps(pool);

  await client.query('SAVEPOINT audience_batch');
  const recoveries=[];
  for(let i=0;i<21;i++)recoveries.push(await fixture(client,{status:'WAITING_VENDOR'}));
  await maintainWaitingFollowUps(pool);
  const waiting=(await client.query('SELECT event_id FROM ticket_waiting_signals WHERE ticket_id=ANY($1::uuid[])',[recoveries])).rows;
  const waitingIds=[];
  await client.query('UPDATE employees SET active=false WHERE id=$1',[person('owner')]);
  await client.query("UPDATE role_bindings SET status='REVOKED' WHERE employee_id=$1",[person('lead')]);
  for(const event of waiting){
    const outbox=(await client.query('SELECT id FROM outbox_events WHERE event_id=$1',[event.event_id])).rows[0].id;
    waitingIds.push(outbox);await expandNotification(client,outbox,event.event_id);
  }
  await client.query('UPDATE outbox_events SET audience_checked_at=NULL WHERE id=ANY($1::uuid[])',[waitingIds]);
  await client.query('UPDATE employees SET active=true WHERE id=$1',[person('owner')]);
  const deliveryCount=async()=>(await client.query('SELECT count(*) FROM notification_deliveries WHERE outbox_id=ANY($1::uuid[])',
    [waitingIds])).rows[0].count;
  await assert.rejects(refreshWaitingNotificationAudiences(isolatedPool(client,{audienceIds:waitingIds,failDeliveryAt:2})),/CI_DELIVERY_FAILURE/);
  assert.equal(await deliveryCount(),'0','failed recipient batch rolls back all earlier deliveries');
  assert.equal((await client.query('SELECT count(*) FROM outbox_events WHERE id=ANY($1::uuid[]) AND audience_checked_at IS NOT NULL',
    [waitingIds])).rows[0].count,'0','failed recipient batch rolls back freshness timestamps');
  const recoveryPool=isolatedPool(client,{audienceIds:waitingIds});
  await refreshWaitingNotificationAudiences(recoveryPool);assert.equal(await deliveryCount(),'20');
  await refreshWaitingNotificationAudiences(recoveryPool);assert.equal(await deliveryCount(),'21','bounded polls do not starve older events');
  await client.query("UPDATE notification_deliveries SET state='DEAD' WHERE outbox_id=ANY($1::uuid[])",[waitingIds]);
  await client.query('UPDATE outbox_events SET audience_checked_at=NULL WHERE id=ANY($1::uuid[])',[waitingIds]);
  await refreshWaitingNotificationAudiences(recoveryPool);
  assert.equal((await client.query("SELECT count(*) FROM notification_deliveries WHERE outbox_id=ANY($1::uuid[]) AND state='DEAD'",
    [waitingIds])).rows[0].count,'21','automatic audience refresh does not blindly resend failed deliveries');
  await client.query('ROLLBACK TO SAVEPOINT audience_batch');

  const batch=[];
  for(let i=0;i<101;i++)batch.push(await fixture(client));
  const batchCount=async()=>(await client.query('SELECT count(*) FROM ticket_waiting_signals WHERE ticket_id=ANY($1::uuid[])',[batch])).rows[0].count;
  await maintainWaitingFollowUps(pool);assert.equal(await batchCount(),'100','scanner respects the 100-ticket bound');
  await maintainWaitingFollowUps(pool);assert.equal(await batchCount(),'101','already signaled tickets cannot starve the next batch');
  await client.query('ROLLBACK');

  // Commit only minimal synthetic fixtures for real concurrent PostgreSQL transactions; no external sender is enabled.
  await client.query('BEGIN');
  await client.query('INSERT INTO employees(id,display_name) VALUES($1,$1),($2,$2)',[person('requester'),person('owner')]);
  await client.query('INSERT INTO support_groups(id,name) VALUES($1,$1)',[group]);
  await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES($1,$2)',[person('owner'),group]);
  await client.query("INSERT INTO service_catalog(code,type,form_version,published,group_id) VALUES($1,'INC',1,true,$2)",[prefix,group]);
  const concurrent=await fixture(client,{route:{}}),locked=await fixture(client,{route:{}});
  await client.query('COMMIT');
  await client.query('BEGIN');await client.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE',[locked]);
  await Promise.all([maintainWaitingFollowUps(db),maintainWaitingFollowUps(db)]);
  assert.equal((await signals(db,locked)).length,0,'competing scans skip a ticket locked by another transaction');
  await client.query('COMMIT');
  await Promise.all([maintainWaitingFollowUps(db),maintainWaitingFollowUps(db)]);
  for(const ticket of [concurrent,locked]){
    const concurrentSignals=await signals(db,ticket);assert.equal(concurrentSignals.length,1,'independent scans emit exactly one signal');
    for(const table of ['ticket_events','audit_logs','outbox_events'])
      assert.equal((await db.query(`SELECT count(*) FROM ${table} WHERE ${table==='ticket_events'?'id':'event_id'}=$1`,
        [concurrentSignals[0].event_id])).rows[0].count,'1');
  }
  await db.query("UPDATE tickets SET status='CANCELLED' WHERE id=ANY($1::uuid[])",[[concurrent,locked]]);
  console.log('Waiting reminders verified: precise deadlines, live qualification, stale episode suppression, send-time revocation, atomic rollback, bounded recovery and concurrent deduplication');
}finally{
  if(client){await client.query('ROLLBACK');client.release();}
  await db.end();
}
