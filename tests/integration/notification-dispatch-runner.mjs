import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DEFAULT_CALENDAR } from '@itsm/contracts';
import { deliverNotification, NotificationBeforeSendError, parseNotificationResponse, serializeNotificationRequest } from './apps/worker/dist/notification-delivery.js';

if (process.env.ITSM_NOTIFICATION_CI !== 'true' || process.env.NODE_ENV === 'production') throw new Error('DISPOSABLE_NOTIFICATION_CI_ONLY');
const db = new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  statement_timeout:5000});
const fixture = `dispatch-${randomUUID()}`;
const corpId = fixture;
const userId = `${fixture}-user`;
const agentId = '123';
const taskId = '9223372036854775807';
const forcedFailure = new Error('Simulated interruption after provider submission');
let calls = [];
let answer;

async function transaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function setup() {
  await db.query('INSERT INTO employees(id,display_name) VALUES ($1,$1)',[fixture]);
  await db.query('INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES ($1,$2,$1)',[fixture,userId]);
  await db.query('INSERT INTO support_groups(id,name) VALUES ($1,$1)',[fixture]);
  await db.query("INSERT INTO service_catalog(code,type,form_version,published,group_id,name) VALUES ($1,'INC',1,true,$1,'CI notification dispatch fixture')",[fixture]);
}

async function delivery() {
  const ids = {ticket:randomUUID(), event:randomUUID(), outbox:randomUUID(), delivery:randomUUID()};
  await db.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
    subject,description,fields,impact,urgency,priority,status) VALUES ($1,$2,$3,$3,$3,$3,'INC',1,
    'Notification recovery fixture','Disposable CI only','{}','INDIVIDUAL','LOW','P4','IN_PROGRESS')`,[ids.ticket,ids.ticket,fixture]);
  await db.query(`INSERT INTO sla_cycles(ticket_id,cycle,priority,calendar_snapshot,started_at,response_target,resolution_target)
    VALUES ($1,1,'P4',$2,now(),540,2700)`,[ids.ticket,JSON.stringify(DEFAULT_CALENDAR)]);
  await db.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,detail,request_id)
    VALUES ($1,$2,$3,'ACCEPT','IN_PROGRESS','{}',$4)`,[ids.event,ids.ticket,fixture,randomUUID()]);
  await db.query(`INSERT INTO outbox_events(id,ticket_id,event_id,kind,payload,expanded_at,state)
    VALUES ($1,$2,$3,'P1_ALERT','{}',now(),'EXPANDED')`,[ids.outbox,ids.ticket,ids.event]);
  await db.query(`INSERT INTO notification_deliveries(id,outbox_id,employee_id,next_at) VALUES ($1,$2,$3,'-infinity')`,
    [ids.delivery,ids.outbox,fixture]);
  return ids;
}

const row = async ids => (await db.query(`SELECT d.state,d.provider_task_id,d.last_error,s.responded_at
  FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id JOIN sla_cycles s ON s.ticket_id=o.ticket_id
  WHERE d.id=$1`,[ids.delivery])).rows[0];
const due = ids => db.query("UPDATE notification_deliveries SET next_at='-infinity' WHERE id=$1",[ids.delivery]);
const options = {
  transaction, mode:'dingtalk', production:false, live:true, corpId, agentId, publicUrl:'https://itsm.example.test/',
  provider:async (operation,body) => { calls.push({operation,body}); return answer(operation,body); }
};
const deliver = extra => deliverNotification({...options,...extra});
const operations = () => calls.map(call => call.operation);
const taskResponse = parseNotificationResponse(`{"errcode":0,"task_id":${taskId}}`);

try {
  assert.equal(taskResponse.task_id,taskId,'provider task IDs retain all digits');
  assert.equal(serializeNotificationRequest({agent_id:agentId,task_id:taskId}),`{"agent_id":123,"task_id":${taskId}}`);
  assert.throws(() => serializeNotificationRequest({task_id:'9223372036854775808'}),/INVALID_DINGTALK_ID/);
  await setup();
  const outsidePilot=await delivery();
  await deliver({pilotUserIds:['another-person']});
  assert.deepEqual(calls,[],'historical queued messages outside the pilot never reach the provider');
  assert.equal((await row(outsidePilot)).state,'SKIPPED');
  assert.equal((await row(outsidePilot)).last_error,'RECIPIENT_OUTSIDE_PILOT');
  const pilot=await delivery();
  answer=async operation=>operation==='asyncsend_v2'?taskResponse:{send_result:{unread_user_id_list:[userId]}};
  await deliver({pilotUserIds:[userId]});
  assert.equal((await row(pilot)).state,'SENDING','included pilot identity can be sent');
  await due(pilot);await deliver({pilotUserIds:[userId]});
  assert.equal((await row(pilot)).state,'DELIVERED');
  const removedPilot=await delivery();
  await deliver({pilotUserIds:[userId]});
  const callsBeforeRemoval=calls.length;
  await due(removedPilot);await deliver({pilotUserIds:['another-person']});
  assert.equal(calls.length,callsBeforeRemoval,'removed pilot identity is not polled or resent');
  assert.equal((await row(removedPilot)).last_error,'RECIPIENT_OUTSIDE_PILOT');
  const beforeSendRemoval=await delivery();
  const mutablePilot=[userId];let pilotTransactions=0;
  await deliver({pilotUserIds:mutablePilot,transaction:async fn=>{
    const result=await transaction(fn);if(++pilotTransactions===1)mutablePilot.length=0;return result;
  }});
  assert.equal(calls.length,callsBeforeRemoval,'pilot scope is checked again after committing the dispatch checkpoint');
  assert.equal((await row(beforeSendRemoval)).last_error,'RECIPIENT_OUTSIDE_PILOT');
  calls=[];
  const ambiguous = await delivery();
  let checkpoint;
  answer = async () => {
    checkpoint = (await row(ambiguous)).state;
    await deliver();
    throw new Error('Provider accepted request, response lost');
  };
  await deliver();
  assert.equal(checkpoint,'DISPATCHING','checkpoint committed before network call');
  assert.deepEqual(operations(),['asyncsend_v2'],'concurrent worker does not duplicate submission');
  assert.equal(calls[0].body.to_all_user,false);assert.equal(calls[0].body.userid_list,userId);
  assert.equal(calls[0].body.msg.msgtype,'action_card');
  assert.equal(calls[0].body.msg.action_card.single_url,`https://itsm.example.test/#/tickets/${ambiguous.ticket}`);
  assert.equal(calls[0].body.msg.action_card.single_title,'查看并处理');
  assert.equal(JSON.stringify(calls[0].body.msg).includes('Disposable CI only'),false);
  assert.deepEqual(await row(ambiguous),{state:'REVIEW_REQUIRED',provider_task_id:null,last_error:'DINGTALK_SEND_UNCONFIRMED',responded_at:null});
  await due(ambiguous);
  await deliver();
  assert.deepEqual(operations(),['asyncsend_v2'],'uncertain outcome does not reenter send queue');

  const crash = await delivery();
  calls = [];
  answer = async () => taskResponse;
  let transactionCount = 0;
  await assert.rejects(deliver({transaction:fn => transaction(async client => {
    const result = await fn(client);
    if (++transactionCount===2) throw forcedFailure;
    return result;
  })}),error => error === forcedFailure);
  assert.equal((await row(crash)).state,'DISPATCHING');
  await due(crash);
  await deliver();
  assert.deepEqual(operations(),['asyncsend_v2'],'recovery never repeats a submission after rollback');
  assert.equal((await row(crash)).state,'REVIEW_REQUIRED');

  const retry = await delivery();
  calls = [];
  answer = async () => { throw new NotificationBeforeSendError('TOKEN_FAILED'); };
  await deliver();
  assert.equal((await row(retry)).state,'PENDING');
  assert.equal((await row(retry)).last_error,'TOKEN_FAILED');
  await due(retry);
  answer = async operation => operation==='asyncsend_v2' ? taskResponse : {send_result:{unread_user_id_list:[userId],failed_user_id_list:[userId]}};
  await deliver();
  assert.equal((await row(retry)).provider_task_id,taskId);
  assert.equal((await row(retry)).responded_at,null,'submission alone is not response evidence');
  await due(retry);
  await deliver();
  assert.equal((await row(retry)).state,'SENDING');
  assert.equal((await row(retry)).responded_at,null,'conflicting failed receipt does not count as response');
  answer = async () => ({send_result:{unread_user_id_list:[userId]}});
  await due(retry);
  await deliver();
  assert.deepEqual(operations(),['asyncsend_v2','asyncsend_v2','getsendresult','getsendresult']);
  assert.equal(calls[2].body.task_id,taskId);
  assert.equal((await row(retry)).state,'DELIVERED');
  assert.ok((await row(retry)).responded_at);

  const moved = await delivery();
  calls = [];
  answer = async () => taskResponse;
  await deliver();
  assert.equal((await row(moved)).provider_task_id,taskId,'persist the submission before changing the recipient identity');
  await db.query('UPDATE identity_links SET ding_user_id=$2 WHERE corp_id=$1',[corpId,`${userId}-changed`]);
  await due(moved);
  await deliver();
  assert.deepEqual(operations(),['asyncsend_v2'],'identity changed before receipt query');
  assert.deepEqual(await row(moved),{state:'REVIEW_REQUIRED',provider_task_id:taskId,last_error:'PROVIDER_RECIPIENT_CHANGED',responded_at:null});

  const simulated = await delivery();
  calls = [];
  await deliver({mode:'fake'});
  assert.equal((await row(simulated)).state,'SIMULATED');
  assert.equal((await row(simulated)).responded_at,null);
  assert.deepEqual(calls,[]);
  console.log('Verified durable notification dispatch, receipt-only retries, exact task IDs, identity changes and SLA evidence');
} finally { await db.end(); }
