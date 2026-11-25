import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { P1_REVIEW_REMINDER_MINUTES, prioritySlaMeasurements } from '@itsm/contracts';
import { maintainRequestApprovals,processNextRequestApproval } from './request-approval.js';
import { dingtalkRequestApproval } from './dingtalk-request-approval.js';
import { maintainRequestFulfillments,processNextRequestDelivery } from './request-fulfillment.js';
import { fulfillmentReminderMinutes,maintainFulfillmentAttention } from './fulfillment-attention.js';
import { maintainWaitingFollowUps } from './waiting-follow-up.js';
import { shouldAutoClose } from './auto-close.js';
import { deliverNotification, NotificationBeforeSendError, parseNotificationResponse, serializeNotificationRequest } from './notification-delivery.js';
import { expandPendingNotifications, refreshFulfillmentNotificationAudiences, refreshWaitingNotificationAudiences } from './notification-audience.js';
import { dingtalkDirectory } from './directory-provider.js';
import { directorySettings,synchronizeDirectory } from './directory-sync.js';
import { dingtalkPilotUsers } from './dingtalk-pilot.js';
import { recoverOwnership } from './ownership-recovery.js';
import {expireAssignments} from './assignment-expiry.js';
import {maintainAutomaticDispatch} from '@itsm/workflow';

const db = new Pool({ host:process.env.DB_HOST ?? 'db',database:process.env.DB_NAME ?? 'itsm',user:process.env.DB_USER ?? 'itsm',password:process.env.DB_PASSWORD,
  application_name:'itsm-worker',connectionTimeoutMillis:5000,statement_timeout:30000 });
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let access: { token:string; expires:number } | undefined;
const mode = process.env.NOTIFICATION_MODE ?? 'disabled';
const pilotUserIds=dingtalkPilotUsers(process.env);
const liveApproval=process.env.ENABLE_LIVE_OA_APPROVAL==='true';
if(liveApproval&&(!process.env.DINGTALK_CORP_ID||!process.env.DINGTALK_APP_KEY||!process.env.DINGTALK_APP_SECRET))
  throw new Error('OA_APPROVAL_NOT_CONFIGURED');
async function applicationToken(signal:AbortSignal){
  if(!access||access.expires<Date.now()){
    const url=new URL('https://oapi.dingtalk.com/gettoken');
    url.searchParams.set('appkey',process.env.DINGTALK_APP_KEY!);
    url.searchParams.set('appsecret',process.env.DINGTALK_APP_SECRET!);
    const response=await fetch(url,{signal,redirect:'error'});
    if(!response.ok)throw new Error('OA_TOKEN_UNAVAILABLE');
    const data=await response.json() as {errcode?:number;access_token?:string;expires_in?:number};
    if(data.errcode!==0||!data.access_token)throw new Error('OA_TOKEN_UNAVAILABLE');
    access={token:data.access_token,expires:Date.now()+Math.min(data.expires_in??7200,7200)*1000-60000};
  }
  return access.token;
}
const approvalProvider=liveApproval?dingtalkRequestApproval({corpId:process.env.DINGTALK_CORP_ID!,token:applicationToken}):undefined;
const directoryConfig=directorySettings(process.env);
if(directoryConfig&&(!process.env.DINGTALK_APP_KEY||!process.env.DINGTALK_APP_SECRET))throw new Error('DIRECTORY_CONFIG_INVALID');
const directoryProvider=directoryConfig?dingtalkDirectory({roots:directoryConfig.roots,token:async signal=>{
  try{return await applicationToken(signal);}catch{throw new Error('DIRECTORY_TOKEN_UNAVAILABLE');}
}}):undefined;
let directoryNextAt=0;
let directoryTask:Promise<void>|undefined;
function scheduleDirectory(){
  if(!directoryConfig||!directoryProvider||directoryTask||Date.now()<directoryNextAt)return;
  // Directory paging must not stall notifications, SLA scans or the worker heartbeat.
  // The database decides the daily cadence. Frequent polling only picks up manual requests.
  directoryNextAt=Date.now()+10000;
  directoryTask=synchronizeDirectory(db,directoryConfig,directoryProvider,{scheduled:true})
    .then(()=>{}).catch(()=>{directoryNextAt=Date.now()+60000;}).finally(()=>{directoryTask=undefined;});
}
const fulfillmentReminders={
  reviewMinutes:fulfillmentReminderMinutes(process.env.FULFILLMENT_REVIEW_REMINDER_MINUTES,1440),
  revokeMinutes:fulfillmentReminderMinutes(process.env.FULFILLMENT_REVOKE_REMINDER_MINUTES,60),
};

async function transaction<T>(fn:(client:PoolClient)=>Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function provider(path: 'asyncsend_v2' | 'getsendresult', body: object) {
  if (!process.env.DINGTALK_APP_KEY || !process.env.DINGTALK_APP_SECRET || !process.env.DINGTALK_AGENT_ID || !process.env.DINGTALK_CORP_ID)
    throw new NotificationBeforeSendError('DINGTALK_NOT_CONFIGURED');
  if (!access || access.expires < Date.now()) {
    const url = new URL('https://oapi.dingtalk.com/gettoken');
    url.searchParams.set('appkey',process.env.DINGTALK_APP_KEY); url.searchParams.set('appsecret',process.env.DINGTALK_APP_SECRET);
    try {
      const response = await fetch(url,{ signal:AbortSignal.timeout(10000),redirect:'error' });
      const data = await response.json() as { errcode?: number; access_token?: string; expires_in?: number };
      if (!response.ok || data.errcode!==0 || typeof data.access_token!=='string' || !data.access_token)
        throw new Error('Invalid DingTalk token response');
      access = { token:data.access_token,expires:Date.now()+Math.min(data.expires_in ?? 7200,7200)*1000-60000 };
    } catch { throw new NotificationBeforeSendError('TOKEN_FAILED'); }
  }
  const response = await fetch(`https://oapi.dingtalk.com/topapi/message/corpconversation/${path}?access_token=${encodeURIComponent(access.token)}`,{
    method:'POST',headers:{ 'Content-Type':'application/json' },body:serializeNotificationRequest(body),signal:AbortSignal.timeout(10000),redirect:'error',
  });
  const data = parseNotificationResponse(await response.text());
  if (!response.ok || data?.errcode !== 0) { access = undefined; throw new Error('PROVIDER_REJECTED'); }
  return data;
}

const notificationOptions = {
  transaction, mode, production:process.env.NODE_ENV==='production', live:process.env.ENABLE_LIVE_NOTIFICATIONS==='true',
  corpId:process.env.DINGTALK_CORP_ID ?? '', agentId:process.env.DINGTALK_AGENT_ID ?? '', publicUrl:process.env.ITSM_PUBLIC_URL ?? '', provider,pilotUserIds,
};

async function record(client:PoolClient,row:any,action:string,detail:object,from:string,to:string,previous?:any) {
  const event = randomUUID(), request = randomUUID();
  await client.query('INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[event,row.id,'system:scheduler',action,from,to,JSON.stringify(detail),request]);
  const ownership=(value:any)=>({ ownerGroupId:value.owner_group_id,assigneeId:value.assignee_id,pendingGroupId:value.pending_group_id,pendingAssigneeId:value.pending_assignee_id,
    assignmentKind:value.assignment_kind,assignmentState:value.assignment_state,assignmentDueAt:value.assignment_due_at,
    assignmentPolicyVersionId:value.assignment_policy_version_id });
  await client.query('INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',[row.id,event,'system:scheduler',request,action,JSON.stringify({ status:from,...(previous ? ownership(previous) : {}) }),JSON.stringify({ status:to,version:row.version,...ownership(row) })]);
  await client.query('INSERT INTO outbox_events(ticket_id,event_id,kind,payload) VALUES ($1,$2,$3,$4)',[row.id,event,action.startsWith('P1_') ? 'P1_ALERT' : 'TICKET_CHANGED',JSON.stringify({ ticketId:row.id,eventId:event })]);
}

async function priorityReviewTimers() {
  await transaction(async client=>{
    const rows=await client.query(`SELECT t.*,now() AS clock FROM tickets t WHERE priority_review_state='PENDING'
      AND status NOT IN ('CLOSED','CANCELLED','REJECTED') AND (NOT EXISTS
        (SELECT 1 FROM priority_review_signals WHERE ticket_id=t.id AND kind='CANDIDATE' AND generation=t.priority_review_generation) OR
        (priority_candidate_at<=now()-(COALESCE((priority_policy_snapshot->'config'->>'reviewMinutes')::integer,$1) * interval '1 minute') AND NOT EXISTS
          (SELECT 1 FROM priority_review_signals WHERE ticket_id=t.id AND kind='OVERDUE' AND generation=t.priority_review_generation)))
      ORDER BY priority_candidate_at,t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`,[P1_REVIEW_REMINDER_MINUTES]);
    for (const row of rows.rows) {
      const minutes=row.priority_policy_snapshot?.config.reviewMinutes??P1_REVIEW_REMINDER_MINUTES;
      const candidate=await client.query("INSERT INTO priority_review_signals(ticket_id,kind,generation) VALUES ($1,'CANDIDATE',$2) ON CONFLICT DO NOTHING RETURNING kind",[row.id,row.priority_review_generation]);
      if (candidate.rowCount) await record(client,row,'P1_CANDIDATE',{ priority:'P1',reviewState:'PENDING',responseStarted:true,generation:row.priority_review_generation },row.status,row.status);
      if (row.clock.getTime()-row.priority_candidate_at.getTime()>=minutes*60000) {
        const overdue=await client.query("INSERT INTO priority_review_signals(ticket_id,kind,generation) VALUES ($1,'OVERDUE',$2) ON CONFLICT DO NOTHING RETURNING kind",[row.id,row.priority_review_generation]);
        if (overdue.rowCount) await record(client,row,'P1_REVIEW_OVERDUE',{ reason:'PRIORITY_CONFIRMATION_OVERDUE',minutes,generation:row.priority_review_generation },row.status,row.status);
      }
    }
  });
}

async function timers() {
  const candidates=await db.query(`SELECT t.id FROM tickets t WHERE t.status NOT IN ('CLOSED','CANCELLED','REJECTED')
    AND EXISTS(SELECT 1 FROM sla_cycles s WHERE s.ticket_id=t.id)
    ORDER BY t.sla_checked_at NULLS FIRST,t.id LIMIT 100`);
  for(const candidate of candidates.rows)await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    await client.query('SELECT id FROM request_approvals WHERE ticket_id=$1 FOR UPDATE',[candidate.id]);
    await client.query('SELECT id FROM request_fulfillments WHERE ticket_id=$1 FOR UPDATE',[candidate.id]);
    const result = await client.query(`SELECT t.*,s.cycle,s.priority AS sla_priority,s.calendar_snapshot,s.started_at,s.responded_at,s.completed_at,s.paused_at,s.paused_minutes,s.response_target,s.resolution_target,s.priority_obligations,s.pause_history,clock_timestamp() AS clock
      FROM tickets t JOIN sla_cycles s ON s.ticket_id=t.id AND s.cycle=(SELECT max(cycle) FROM sla_cycles WHERE ticket_id=t.id)
      WHERE t.id=$1 AND t.status NOT IN ('CLOSED','CANCELLED','REJECTED') FOR UPDATE OF t SKIP LOCKED`,[candidate.id]);
    for (const row of result.rows) {
      await client.query('UPDATE tickets SET sla_checked_at=now() WHERE id=$1',[row.id]);
      const closeHours = Number(process.env.AUTO_CLOSE_HOURS ?? 72);
      const completionReady=row.service_type!=='REQ'||(await client.query('SELECT request_ticket_completion_ready($1) AS ready',[row.id])).rows[0].ready;
      if (shouldAutoClose(row.status,row.completed_at,row.clock,closeHours)&&completionReady) {
        const updated = await client.query("UPDATE tickets SET status='CLOSED',pending_group_id=NULL,pending_assignee_id=NULL,assignment_kind=NULL,assignment_state=CASE WHEN pending_assignee_id IS NOT NULL THEN 'CANCELLED' ELSE assignment_state END,assignment_offered_at=NULL,assignment_due_at=NULL,assignment_policy_version_id=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id]);
        await record(client,updated.rows[0],'AUTO_CLOSE',{ reason:`待确认超过 ${closeHours} 小时自动关闭` },row.status,'CLOSED',row);
        continue;
      }
      for(const measurement of prioritySlaMeasurements({...row,priority:row.sla_priority},row.clock))
      for (const base of [measurement.responseMinutes > measurement.responseTarget ? 'RESPONSE_BREACH' : '',measurement.resolutionMinutes > measurement.resolutionTarget ? 'RESOLUTION_BREACH' : ''].filter(Boolean)) {
        const kind=measurement.id==='original'?base:`${base}:${measurement.id}`;
        const signal = await client.query('INSERT INTO sla_signals(ticket_id,cycle,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING kind',[row.id,row.cycle,kind]);
        if (signal.rowCount) await record(client,row,'SLA_BREACH',{ cycle:row.cycle,kind,priority:measurement.priority },row.status,row.status);
      }
    }
  });
  await transaction(async client=>{
    await client.query("DELETE FROM auth_sessions WHERE expires_at<now()-interval '1 day'");
    await client.query("DELETE FROM auth_code_uses WHERE created_at<now()-interval '1 day'");
    await client.query('DELETE FROM voice_drafts WHERE expires_at<now()');
    await client.query("DELETE FROM intake_rate_limits WHERE bucket<now()-interval '1 day'");
  });
}
let ticks = 0;
async function tick() {
  timer=undefined;
  try {
    scheduleDirectory();
    await maintainAutomaticDispatch(db);
    await recoverOwnership(db,record);
    if (ticks++ % 15 === 0) { await expireAssignments(db,record); await priorityReviewTimers(); await maintainRequestApprovals(db); await maintainRequestFulfillments(db); await maintainFulfillmentAttention(db,fulfillmentReminders); await maintainWaitingFollowUps(db); await timers(); }
    if(approvalProvider)for(let i=0;i<5&&!stopped;i++)if(!await processNextRequestApproval(db,approvalProvider))break;
    if(approvalProvider&&process.env.ENABLE_MANUAL_REQUEST_DELIVERY==='true')
      for(let i=0;i<5&&!stopped;i++)if(!await processNextRequestDelivery(db,approvalProvider))break;
    await expandPendingNotifications(db);
    await refreshFulfillmentNotificationAudiences(db);
    await refreshWaitingNotificationAudiences(db);
    for (let i=0;i<10 && !stopped;i++) if (!await deliverNotification(notificationOptions)) break;
    await writeFile('/tmp/itsm-worker-heartbeat', String(Date.now()), { mode:0o600 });
  }
  catch { console.error('ITSM worker cycle failed; retrying without logging payloads'); }
  finally { if (!stopped) timer = setTimeout(() => { void tick(); },2000); else { await directoryTask; await db.end(); } }
}
function shutdown() { stopped=true; if (timer) { clearTimeout(timer); void (async()=>{await directoryTask;await db.end();})(); } }
process.once('SIGTERM',shutdown); process.once('SIGINT',shutdown);
console.log(`ITSM worker started; notification mode: ${mode}`);
void tick();
