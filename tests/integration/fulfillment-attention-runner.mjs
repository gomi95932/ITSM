import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { maintainFulfillmentAttention } from './apps/worker/dist/fulfillment-attention.js';
import { notificationRecipients,expandNotification } from './apps/worker/dist/notification-audience.js';

if(process.env.ITSM_ATTENTION_CI!=='true'||process.env.NODE_ENV==='production')throw new Error('DISPOSABLE_ATTENTION_CI_ONLY');
const db=new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,max:5});
const suffix=randomUUID(),group=`attention-${suffix}`,other=`attention-other-${suffix}`;
const person=role=>`attention-${role}-${suffix}`,position=`attention-position-${suffix}`,domain=`attention-domain-${suffix}`;
const roles=['applicant','approver','operator','peer','lead','outsider'];
const policy={reviewMinutes:60,revokeMinutes:30};
const routing={primaryPositionId:position,positions:[{id:position,groupId:group}]};

async function fixture(client,{state='DELIVERED',age=10,expired=false,reviewed=false,route=routing}={}){
  const id=randomUUID(),approval=randomUUID(),ticket=randomUUID();
  await client.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,
    form_version,subject,description,fields,impact,urgency,priority,status,service_routing_snapshot)
    VALUES($1,$2,$3,$3,$4,$5,'REQ',1,'Reminder test','CI-only fixture','{}','INDIVIDUAL','LOW','P4','WAITING_APPROVAL',$6)`,
  [ticket,`REQ-${ticket}`,person('applicant'),group,`REQ-ATTENTION-${suffix}`,JSON.stringify(route)]);
  const snapshot={applicant:{employeeId:person('applicant')},approvers:[{employeeId:person('approver')}]};
  await client.query(`INSERT INTO request_approvals(id,ticket_id,corp_id,snapshot,expires_at,state,provider_instance_id,last_verified_at,next_at)
    VALUES($1::uuid,$2,'attention-ci',$3,now()+interval '1 day','APPROVED',$1::text,now(),now()+interval '1 day')`,
  [approval,ticket,JSON.stringify(snapshot)]);
  const delivered=['DELIVERED','REVOKE_DUE','REVOKED'].includes(state);
  await client.query(`INSERT INTO request_fulfillments(id,approval_id,ticket_id,assignee_id,ready_until,state,
    delivered_at,access_expires_at,reviewed_at,reviewed_by,revoked_at,updated_at)
    VALUES($1,$2,$3,$4,now()+interval '1 day',$5,
      CASE WHEN $6 THEN now()-$7*interval '1 minute' END,
      CASE WHEN $6 THEN now()+(CASE WHEN $8 THEN -1 ELSE 1440 END)*interval '1 minute' END,
      CASE WHEN $9 THEN now() END,CASE WHEN $9 THEN $10 END,CASE WHEN $5='REVOKED' THEN now() END,
      now()-$7*interval '1 minute')`,
  [id,approval,ticket,person('operator'),state,delivered,age,expired,reviewed,person('peer')]);
  return {id,approval,ticket};
}
async function signals(client,id){
  return (await client.query(`SELECT s.*,o.id AS outbox_id FROM request_fulfillment_signals s
    JOIN outbox_events o ON o.event_id=s.event_id WHERE s.fulfillment_id=$1 ORDER BY s.kind`,[id])).rows;
}
async function recipients(client,event){return notificationRecipients(client,event);}
async function expectFailure(client,action,pattern){
  await client.query('SAVEPOINT expected_failure');
  try{await assert.rejects(action,pattern);}finally{await client.query('ROLLBACK TO SAVEPOINT expected_failure');}
}

// Uncommitted fixtures are invisible to the live CI worker. Production scan transactions become nested savepoints.
function isolatedPool(client,{failOutbox=false}={}){
  return {
    async query(){
      return client.query(`SELECT approval_id FROM request_fulfillment_attention_pending WHERE group_id IN ($1,$2)
        GROUP BY approval_id ORDER BY min(since_at),approval_id LIMIT 100`,[group,other]);
    },
    async connect(){return {
      async query(text,params){
        if(text==='BEGIN')return client.query('SAVEPOINT attention_scan');
        if(text==='COMMIT')return client.query('RELEASE SAVEPOINT attention_scan');
        if(text==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT attention_scan');
        if(failOutbox&&text.includes('INSERT INTO outbox_events'))throw new Error('CI_OUTBOX_FAILURE');
        return client.query(text,params);
      },release(){},
    };},
  };
}

let client;
try{
  client=await db.connect();await client.query('BEGIN');
  for(const role of roles)await client.query('INSERT INTO employees(id,display_name) VALUES($1,$2)',[person(role),`CI ${role}`]);
  await client.query('INSERT INTO support_groups(id,name) VALUES($1,$1),($2,$2)',[group,other]);
  for(const role of roles)await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES($1,$2)',
    [person(role),role==='outsider'?other:group]);
  const leadRole=randomUUID();
  await client.query(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,source,requested_by,reviewed_by,reason)
    VALUES($1,$2,'GROUP_LEAD',$3,now()-interval '1 day',now()+interval '1 day','ACTIVE','REVIEW',$4,$5,'CI-only reviewed role')`,
  [leadRole,person('lead'),group,person('applicant'),person('approver')]);
  await client.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id,name)
    VALUES($1,'REQ',1,true,$2,'Reminder test')`,[`REQ-ATTENTION-${suffix}`,group]);
  const config={domains:[{id:domain,name:'CI reminders',enabled:true}],systems:[],
    positions:[{id:position,name:'CI operator',domainId:domain,groupId:group,enabled:true}],
    appointments:['applicant','approver','operator','peer'].map(role=>({id:randomUUID(),positionId:position,employeeId:person(role),
      duty:'PRIMARY',enabled:true,validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString()})),mappings:[]};
  await client.query('SELECT pg_advisory_xact_lock(71820512)');
  await client.query('SELECT version FROM service_structure_current WHERE id FOR UPDATE');
  await client.query(`INSERT INTO service_structure_versions(version,config)
    SELECT v.version+1,jsonb_build_object('domains',(v.config->'domains')||$1::jsonb,
      'systems',v.config->'systems','positions',(v.config->'positions')||$2::jsonb,
      'appointments',(v.config->'appointments')||$3::jsonb,'mappings',v.config->'mappings')
    FROM service_structure_current c JOIN service_structure_versions v ON v.version=c.version WHERE c.id`,
  [JSON.stringify(config.domains),JSON.stringify(config.positions),JSON.stringify(config.appointments)]);
  await client.query('UPDATE service_structure_current SET version=version+1 WHERE id');
  const pool=isolatedPool(client);

  const fresh=await fixture(client);
  const before=(await client.query(`SELECT f.version,t.version AS ticket_version,t.status,f.state FROM request_fulfillments f
    JOIN tickets t ON t.id=f.ticket_id WHERE f.id=$1`,[fresh.id])).rows[0];
  await maintainFulfillmentAttention(pool,policy);
  const [review]=await signals(client,fresh.id);
  assert.equal(review.kind,'REVIEW_REQUIRED');
  assert.deepEqual(await recipients(client,review.event_id),[person('peer')]);
  assert.deepEqual(await notificationRecipients(client,review.event_id,person('applicant')),[]);
  await expandNotification(client,review.outbox_id,review.event_id);
  await expandNotification(client,review.outbox_id,review.event_id);
  assert.equal((await client.query('SELECT count(*) FROM notification_deliveries WHERE outbox_id=$1',[review.outbox_id])).rows[0].count,'1');
  await client.query('UPDATE employees SET active=false WHERE id=$1',[person('peer')]);
  assert.deepEqual(await notificationRecipients(client,review.event_id,person('peer')),[],'send-time qualification rejects departed peer');
  await client.query('UPDATE employees SET active=true WHERE id=$1',[person('peer')]);
  await client.query('DELETE FROM group_memberships WHERE group_id=$1 AND employee_id=$2',[group,person('peer')]);
  assert.deepEqual(await recipients(client,review.event_id),[],'removed group member receives no reminder');
  await client.query('INSERT INTO group_memberships(group_id,employee_id) VALUES($1,$2)',[group,person('peer')]);
  await client.query('SAVEPOINT withdrawn_appointment');
  const withdrawn=structuredClone((await client.query(`SELECT v.config FROM service_structure_current c
    JOIN service_structure_versions v ON v.version=c.version WHERE c.id`)).rows[0].config);
  withdrawn.appointments.find(item=>item.positionId===position&&item.employeeId===person('peer')).enabled=false;
  await client.query(`INSERT INTO service_structure_versions(version,config)
    SELECT version+1,$1 FROM service_structure_current WHERE id`,[JSON.stringify(withdrawn)]);
  await client.query('UPDATE service_structure_current SET version=version+1 WHERE id');
  assert.deepEqual(await recipients(client,review.event_id),[],'current appointment withdrawal blocks an already expanded recipient');
  await client.query('ROLLBACK TO SAVEPOINT withdrawn_appointment');
  assert.deepEqual(await recipients(client,review.event_id),[person('peer')]);
  await maintainFulfillmentAttention(pool,{reviewMinutes:1,revokeMinutes:1});
  const repeated=await signals(client,fresh.id);
  assert.equal(repeated.length,1,'polling and changed environment thresholds never reset an existing deadline');
  assert.equal(repeated[0].escalate_at.getTime(),review.escalate_at.getTime());
  assert.deepEqual((await client.query(`SELECT f.version,t.version AS ticket_version,t.status,f.state FROM request_fulfillments f
    JOIN tickets t ON t.id=f.ticket_id WHERE f.id=$1`,[fresh.id])).rows[0],before);
  await expectFailure(client,()=>client.query('UPDATE request_fulfillment_signals SET escalate_at=now() WHERE fulfillment_id=$1',[fresh.id]),
    /REQUEST_CATALOG_VERSION_IMMUTABLE/);
  await expectFailure(client,()=>client.query('DELETE FROM request_fulfillment_signals WHERE fulfillment_id=$1',[fresh.id]),
    /REQUEST_CATALOG_VERSION_IMMUTABLE/);
  await client.query(`SELECT perform_request_fulfillment_action($1,$2,'REVIEW','CI-REVIEW-REMINDER',NULL)`,[fresh.approval,person('peer')]);
  assert.deepEqual(await recipients(client,review.event_id),[],'reviewed tasks suppress unsent reminders');

  const old=await fixture(client,{age:120});
  await maintainFulfillmentAttention(pool,policy);await maintainFulfillmentAttention(pool,policy);
  const oldSignals=await signals(client,old.id);
  assert.deepEqual(oldSignals.map(signal=>signal.kind),['REVIEW_OVERDUE','REVIEW_REQUIRED']);
  const overdue=oldSignals.find(signal=>signal.kind==='REVIEW_OVERDUE');
  assert.deepEqual(await recipients(client,overdue.event_id),[person('lead')]);
  await client.query('SAVEPOINT lead_qualification');
  for(const change of ["status='REVOKED'","valid_to=now()-interval '1 second'","valid_from=now()+interval '1 hour'"]){
    await client.query(`UPDATE role_bindings SET ${change} WHERE id=$1`,[leadRole]);
    assert.deepEqual(await recipients(client,overdue.event_id),[],'escalation requires current, active lead authority');
    await client.query('ROLLBACK TO SAVEPOINT lead_qualification');
  }
  await client.query('UPDATE employees SET active=false WHERE id=$1',[person('lead')]);
  assert.deepEqual(await recipients(client,overdue.event_id),[]);
  await client.query('ROLLBACK TO SAVEPOINT lead_qualification');
  assert.deepEqual(await recipients(client,overdue.event_id),[person('lead')]);
  assert.equal(oldSignals[0].escalate_at.getTime(),oldSignals[1].escalate_at.getTime());

  const revoked=await fixture(client,{expired:true,age:180,reviewed:true});
  await client.query("UPDATE tickets SET status='CLOSED' WHERE id=$1",[revoked.ticket]);
  await maintainFulfillmentAttention(pool,policy);
  const [revoke]=await signals(client,revoked.id);
  assert.equal(revoke.kind,'REVOKE_REQUIRED','closed tickets still require actual access revocation');
  assert.deepEqual(await recipients(client,revoke.event_id),['applicant','approver','lead','operator','peer'].map(person).sort(),
    'revocation includes current appointed operators plus lead fallback, never unrelated employees');
  await client.query(`SELECT perform_request_fulfillment_action($1,$2,'REVOKE','CI-REVOKE-REMINDER',NULL)`,[revoked.approval,person('lead')]);
  assert.deepEqual(await recipients(client,revoke.event_id),[],'actual revocation suppresses old delivery attempts');

  const expiredReview=await fixture(client,{age:180,expired:true}),expiredEvent=randomUUID();
  await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,request_id)
    VALUES($1::uuid,$2,'system:scheduler','FULFILLMENT_REVIEW_REQUIRED','WAITING_APPROVAL',$1::text)`,[expiredEvent,expiredReview.ticket]);
  await client.query(`INSERT INTO request_fulfillment_signals(fulfillment_id,group_id,kind,event_id,escalate_at)
    VALUES($1,$2,'REVIEW_REQUIRED',$3,now()+interval '1 hour')`,[expiredReview.id,group,expiredEvent]);
  assert.deepEqual(await recipients(client,expiredEvent),[],'expired access needs revocation, not a stale independent-review message');
  await maintainFulfillmentAttention(pool,policy);

  const due=await fixture(client,{state:'REVOKE_DUE',age:240});
  await client.query(`INSERT INTO request_fulfillment_events(fulfillment_id,action,to_state,created_at)
    VALUES($1,'REVOCATION_REQUIRED','REVOKE_DUE',now()-interval '2 hours')`,[due.id]);
  await maintainFulfillmentAttention(pool,policy);await maintainFulfillmentAttention(pool,policy);
  const dueSignals=await signals(client,due.id);
  assert.deepEqual(dueSignals.map(signal=>signal.kind),['REVOKE_OVERDUE','REVOKE_REQUIRED']);
  assert.deepEqual(await recipients(client,dueSignals[0].event_id),[person('lead')]);
  assert.ok(dueSignals[0].escalate_at<Date.now(),'early invalidation uses first revocation obligation, not future access expiry');

  const moved=await fixture(client,{route:{}});
  await maintainFulfillmentAttention(pool,policy);
  const [oldGroup]=await signals(client,moved.id);
  await client.query('UPDATE tickets SET owner_group_id=$2 WHERE id=$1',[moved.ticket,other]);
  assert.deepEqual(await recipients(client,oldGroup.event_id),[],'old responsibility group must not receive a stale reminder');
  await maintainFulfillmentAttention(pool,policy);
  const currentGroup=(await signals(client,moved.id)).find(signal=>signal.group_id===other);
  assert.ok(currentGroup);assert.deepEqual(await recipients(client,currentGroup.event_id),[person('outsider')]);

  for(const options of [{state:'READY'},{state:'BLOCKED'},{state:'REVOKED',expired:true},{reviewed:true}]){
    const ignored=await fixture(client,options);await maintainFulfillmentAttention(pool,policy);
    assert.deepEqual(await signals(client,ignored.id),[],'completed or not-yet-delivered tasks produce no attention event');
  }

  // A forged action without an authoritative signal cannot expand a fulfillment notification.
  const fake=randomUUID();
  await client.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,request_id)
    VALUES($1::uuid,$2,'system:scheduler','FULFILLMENT_REVIEW_REQUIRED','WAITING_APPROVAL',$1::text)`,[fake,fresh.ticket]);
  assert.deepEqual(await recipients(client,fake),[]);

  // Isolate the deliberate write failure so the live worker cannot race the rollback assertion.
  const atomic=await fixture(client);
  await assert.rejects(maintainFulfillmentAttention(isolatedPool(client,{failOutbox:true}),policy),/CI_OUTBOX_FAILURE/);
  assert.deepEqual(await signals(client,atomic.id),[]);
  for(const table of ['ticket_events','audit_logs','outbox_events'])
    assert.equal((await client.query(`SELECT count(*) FROM ${table} WHERE ticket_id=$1`,[atomic.ticket])).rows[0].count,'0',
      'event, signal, audit and outbox must roll back as one transaction');
  await maintainFulfillmentAttention(pool,policy);
  assert.equal((await signals(client,atomic.id)).length,1);
  const audit=(await client.query(`SELECT count(*) FROM request_fulfillment_signals s
    JOIN ticket_events e ON e.id=s.event_id JOIN audit_logs a ON a.event_id=e.id
    JOIN outbox_events o ON o.event_id=e.id WHERE s.fulfillment_id=$1`,[atomic.id])).rows[0];
  assert.equal(audit.count,'1');

  const batch=[];
  for(let i=0;i<101;i++)batch.push((await fixture(client)).id);
  const batchCount=async()=>(await client.query(`SELECT count(*) FROM request_fulfillment_signals
    WHERE fulfillment_id=ANY($1::uuid[])`,[batch])).rows[0].count;
  await maintainFulfillmentAttention(pool,policy);assert.equal(await batchCount(),'100','one poll respects the 100-approval bound');
  await maintainFulfillmentAttention(pool,policy);assert.equal(await batchCount(),'101','already signaled tasks cannot starve the next batch');
  await client.query('COMMIT');client.release();client=null;

  // Real independent transactions and the background worker share the same locks and uniqueness boundary.
  const concurrent=await fixture(db,{state:'REVOKE_DUE',age:240});
  await Promise.all([maintainFulfillmentAttention(db,policy),maintainFulfillmentAttention(db,policy)]);
  await maintainFulfillmentAttention(db,policy);
  const concurrentSignals=await signals(db,concurrent.id);
  assert.deepEqual(concurrentSignals.map(signal=>signal.kind),['REVOKE_OVERDUE','REVOKE_REQUIRED']);
  for(const signal of concurrentSignals){
    assert.equal((await db.query('SELECT count(*) FROM ticket_events WHERE id=$1',[signal.event_id])).rows[0].count,'1');
    assert.equal((await db.query('SELECT count(*) FROM audit_logs WHERE event_id=$1',[signal.event_id])).rows[0].count,'1');
    assert.equal((await db.query('SELECT count(*) FROM outbox_events WHERE event_id=$1',[signal.event_id])).rows[0].count,'1');
  }
  console.log('Fulfillment attention verified: atomic signals, current qualified recipients, persisted deadlines, closed-ticket revocation, lead escalation, suppression and concurrent deduplication');
}finally{
  if(client){await client.query('ROLLBACK');client.release();}
  await db.end();
}
