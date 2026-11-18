import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { P1_REVIEW_REMINDER_MINUTES, serviceMinutes } from '@itsm/contracts';
import { maintainRequestApprovals,processNextRequestApproval } from './request-approval.js';
import { dingtalkRequestApproval } from './dingtalk-request-approval.js';
import { maintainRequestFulfillments,processNextRequestDelivery } from './request-fulfillment.js';
import { fulfillmentReminderMinutes,maintainFulfillmentAttention } from './fulfillment-attention.js';
import { shouldAutoClose } from './auto-close.js';
import { notificationLink } from './notification-message.js';
import { expandNotification, notificationRecipients, refreshFulfillmentNotificationAudiences } from './notification-audience.js';

const db = new Pool({ host:process.env.DB_HOST ?? 'db',database:process.env.DB_NAME ?? 'itsm',user:process.env.DB_USER ?? 'itsm',password:process.env.DB_PASSWORD,
  connectionTimeoutMillis:5000,statement_timeout:30000 });
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let access: { token:string; expires:number } | undefined;
const mode = process.env.NOTIFICATION_MODE ?? 'disabled';
const liveApproval=process.env.ENABLE_LIVE_OA_APPROVAL==='true';
if(liveApproval&&(!process.env.DINGTALK_CORP_ID||!process.env.DINGTALK_APP_KEY||!process.env.DINGTALK_APP_SECRET))
  throw new Error('OA_APPROVAL_NOT_CONFIGURED');
const approvalProvider=liveApproval?dingtalkRequestApproval({corpId:process.env.DINGTALK_CORP_ID!,token:async signal=>{
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
}}):undefined;
const fulfillmentReminders={
  reviewMinutes:fulfillmentReminderMinutes(process.env.FULFILLMENT_REVIEW_REMINDER_MINUTES,1440),
  revokeMinutes:fulfillmentReminderMinutes(process.env.FULFILLMENT_REVOKE_REMINDER_MINUTES,60),
};

async function transaction(fn:(client:PoolClient)=>Promise<void>) {
  const client = await db.connect();
  try { await client.query('BEGIN'); await fn(client); await client.query('COMMIT'); }
  catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function provider(path:string,body?:object):Promise<any> {
  if (!process.env.DINGTALK_APP_KEY || !process.env.DINGTALK_APP_SECRET || !process.env.DINGTALK_AGENT_ID || !process.env.DINGTALK_CORP_ID)
    throw new Error('DINGTALK_NOT_CONFIGURED');
  if (!access || access.expires < Date.now()) {
    const url = new URL('https://oapi.dingtalk.com/gettoken');
    url.searchParams.set('appkey',process.env.DINGTALK_APP_KEY); url.searchParams.set('appsecret',process.env.DINGTALK_APP_SECRET);
    const response = await fetch(url,{ signal:AbortSignal.timeout(10000) }); const data = await response.json() as any;
    if (!response.ok || data.errcode !== 0 || !data.access_token) throw new Error('TOKEN_FAILED');
    access = { token:data.access_token,expires:Date.now()+Math.min(data.expires_in ?? 7200,7200)*1000-60000 };
  }
  const response = await fetch(`https://oapi.dingtalk.com/topapi/message/corpconversation/${path}?access_token=${encodeURIComponent(access.token)}`,{
    method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify(body),signal:AbortSignal.timeout(10000),
  });
  const data = await response.json() as any;
  if (!response.ok || data.errcode !== 0) { access = undefined; throw new Error('PROVIDER_REJECTED'); }
  return data;
}

async function expand() {
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const result = await client.query("SELECT id,event_id FROM outbox_events WHERE expanded_at IS NULL ORDER BY (kind='P1_ALERT') DESC,created_at LIMIT 20 FOR UPDATE SKIP LOCKED");
    for (const event of result.rows) {
      await expandNotification(client,event.id,event.event_id);
    }
  });
}

async function deliver() {
  if (mode === 'disabled') return;
  await transaction(async client => {
    const result = await client.query(`SELECT d.*,t.id AS ticket_id,t.number,t.requester_id,t.owner_group_id,t.pending_assignee_id,t.pending_group_id,e.action,e.to_status,e.id AS event_id
      FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id JOIN ticket_events e ON e.id=o.event_id JOIN tickets t ON t.id=o.ticket_id
      WHERE d.state IN ('PENDING','SENDING') AND d.next_at<=now() ORDER BY (o.kind='P1_ALERT') DESC,d.next_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`);
    const row = result.rows[0]; if (!row) return;
    const permitted = await notificationRecipients(client,row.event_id,row.employee_id);
    const recipient = await client.query(`SELECT e.active,l.ding_user_id FROM employees e
      LEFT JOIN identity_links l ON l.employee_id=e.id AND l.corp_id=$2 WHERE e.id=$1`,[row.employee_id,process.env.DINGTALK_CORP_ID ?? '']);
    const user = recipient.rows[0];
    if (!user?.active || !permitted.length) {
      await client.query("UPDATE notification_deliveries SET state='SKIPPED',last_error='RECIPIENT_NO_LONGER_AUTHORIZED',updated_at=now() WHERE id=$1",[row.id]); return;
    }
    if (mode === 'fake' && process.env.NODE_ENV !== 'production') {
      await client.query("UPDATE notification_deliveries SET state='SIMULATED',attempts=attempts+1,last_error=NULL,updated_at=now() WHERE id=$1",[row.id]); return;
    }
    try {
      if (mode !== 'dingtalk' || process.env.ENABLE_LIVE_NOTIFICATIONS !== 'true') throw new Error('LIVE_DELIVERY_DISABLED');
      if (!user.ding_user_id) throw new Error('RECIPIENT_NOT_LINKED');
      if (row.provider_task_id) {
        const status = await provider('getsendresult',{ agent_id:process.env.DINGTALK_AGENT_ID,task_id:row.provider_task_id });
        const sent = status.send_result?.sent_userid_list ?? [];
        if (!Array.isArray(sent) || !sent.includes(user.ding_user_id)) throw new Error('DELIVERY_NOT_CONFIRMED');
        await client.query("UPDATE notification_deliveries SET state='DELIVERED',last_error=NULL,updated_at=now() WHERE id=$1",[row.id]);
        if (['ACCEPT','ACCEPT_HANDOVER','ACCEPT_OFFER'].includes(row.action) && row.employee_id === row.requester_id)
          await client.query('UPDATE sla_cycles SET responded_at=now() WHERE ticket_id=$1 AND cycle=1 AND responded_at IS NULL',[row.ticket_id]);
      } else {
        const data = await provider('asyncsend_v2',{ agent_id:process.env.DINGTALK_AGENT_ID,userid_list:user.ding_user_id,to_all_user:false,
          msg:{ msgtype:'link',link:notificationLink(process.env.ITSM_PUBLIC_URL ?? '',row) } });
        if (data.task_id === undefined) throw new Error('TASK_NOT_RETURNED');
        await client.query("UPDATE notification_deliveries SET state='SENDING',provider_task_id=$2,attempts=0,next_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1",[row.id,String(data.task_id)]);
      }
    } catch (error) {
      const known = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_UNAVAILABLE';
      const attempts = row.attempts+1, max = row.provider_task_id ? 20 : 5;
      await client.query(`UPDATE notification_deliveries SET state=$2,attempts=$3,last_error=$4,next_at=now()+($5 * interval '1 second'),updated_at=now() WHERE id=$1`,
        [row.id,attempts >= max ? 'DEAD' : row.provider_task_id ? 'SENDING' : 'PENDING',attempts,known,Math.min(3600,5 * 2 ** attempts)]);
    }
  });
}

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
        (SELECT 1 FROM priority_review_signals WHERE ticket_id=t.id AND kind='CANDIDATE') OR
        (priority_candidate_at<=now()-($1 * interval '1 minute') AND NOT EXISTS
          (SELECT 1 FROM priority_review_signals WHERE ticket_id=t.id AND kind='OVERDUE')))
      ORDER BY priority_candidate_at,t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`,[P1_REVIEW_REMINDER_MINUTES]);
    for (const row of rows.rows) {
      const candidate=await client.query("INSERT INTO priority_review_signals(ticket_id,kind) VALUES ($1,'CANDIDATE') ON CONFLICT DO NOTHING RETURNING kind",[row.id]);
      if (candidate.rowCount) await record(client,row,'P1_CANDIDATE',{ priority:'P1',reviewState:'PENDING',responseStarted:true },row.status,row.status);
      if (row.clock.getTime()-row.priority_candidate_at.getTime()>=P1_REVIEW_REMINDER_MINUTES*60000) {
        const overdue=await client.query("INSERT INTO priority_review_signals(ticket_id,kind) VALUES ($1,'OVERDUE') ON CONFLICT DO NOTHING RETURNING kind",[row.id]);
        if (overdue.rowCount) await record(client,row,'P1_REVIEW_OVERDUE',{ reason:'PRIORITY_CONFIRMATION_OVERDUE',minutes:P1_REVIEW_REMINDER_MINUTES },row.status,row.status);
      }
    }
  });
}

async function recoverOwnership() {
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)',[71820512]);
    await client.query(`UPDATE ticket_routing_alerts a SET resolved_at=now() FROM tickets t
      WHERE a.ticket_id=t.id AND a.resolved_at IS NULL AND t.status IN ('CLOSED','CANCELLED','REJECTED')`);
    const rows = await client.query(`SELECT t.* FROM tickets t LEFT JOIN ticket_routing_alerts a ON a.ticket_id=t.id AND a.resolved_at IS NULL
      WHERE t.status NOT IN ('CLOSED','CANCELLED','REJECTED') AND
      ((t.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees e JOIN group_memberships m ON m.employee_id=e.id
        WHERE e.id=t.assignee_id AND e.active AND m.group_id=t.owner_group_id)) OR
       (t.pending_assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees e JOIN group_memberships m ON m.employee_id=e.id
        WHERE e.id=t.pending_assignee_id AND e.active AND m.group_id=t.pending_group_id
          AND service_position_eligible(t.service_routing_snapshot,e.id,t.pending_group_id))) OR
       (t.assignee_id IS NOT NULL AND NOT ticket_processing_eligible(t.id,t.assignee_id)) OR
       a.ticket_id IS NOT NULL OR
       NOT EXISTS (SELECT 1 FROM employees e JOIN group_memberships m ON m.employee_id=e.id
        WHERE e.active AND m.group_id=t.owner_group_id AND service_position_eligible(t.service_routing_snapshot,e.id,t.owner_group_id)))
      ORDER BY COALESCE(a.last_checked_at,t.updated_at),t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`);
    for (const row of rows.rows) {
      const valid = async (employee:string|null,group:string|null) => !employee || !!(await client.query(`SELECT e.id FROM employees e
        JOIN group_memberships m ON m.employee_id=e.id WHERE e.id=$1 AND e.active AND m.group_id=$2 FOR SHARE OF e,m`,[employee,group])).rowCount;
      const groupAvailable = async (group:string) => !!(await client.query(`SELECT e.id FROM employees e
        JOIN group_memberships m ON m.employee_id=e.id WHERE e.active AND m.group_id=$1
        AND service_position_eligible($2,e.id,$1)
        ORDER BY e.id LIMIT 1 FOR SHARE OF e,m`,[group,JSON.stringify(row.service_routing_snapshot)])).rowCount;
      const ownerValid = await valid(row.assignee_id,row.owner_group_id);
      const ownerQualified=!row.assignee_id||(await client.query<{eligible:boolean}>(
        'SELECT ticket_processing_eligible($1,$2) AS eligible',[row.id,row.assignee_id])).rows[0].eligible;
      const targetValid = await valid(row.pending_assignee_id,row.pending_group_id) && (!row.pending_assignee_id ||
        (await client.query('SELECT service_position_eligible($1,$2,$3) AS eligible',
          [JSON.stringify(row.service_routing_snapshot),row.pending_assignee_id,row.pending_group_id])).rows[0].eligible);
      let group = row.owner_group_id as string;
      const available = await groupAvailable(group);
      const mapped=Object.keys(row.service_routing_snapshot).length>0;
      if(row.assignee_id&&ownerValid&&!ownerQualified&&available){
        const alert=await client.query(`INSERT INTO ticket_routing_alerts(ticket_id,reason,owner_group_id)
          VALUES($1,'OWNER_APPOINTMENT_REQUIRED',$2) ON CONFLICT(ticket_id) DO UPDATE SET reason=EXCLUDED.reason,
          owner_group_id=EXCLUDED.owner_group_id,opened_at=CASE WHEN ticket_routing_alerts.resolved_at IS NOT NULL THEN now() ELSE ticket_routing_alerts.opened_at END,
          last_checked_at=now(),resolved_at=NULL WHERE ticket_routing_alerts.resolved_at IS NOT NULL
            OR ticket_routing_alerts.reason<>'OWNER_APPOINTMENT_REQUIRED' RETURNING ticket_id`,[row.id,group]);
        if(alert.rowCount)await record(client,row,'OWNERSHIP_ESCALATION_REQUIRED',
          {reason:'OWNER_APPOINTMENT_REQUIRED',ownerGroupId:group},row.status,row.status);
        await client.query('UPDATE ticket_routing_alerts SET last_checked_at=now() WHERE ticket_id=$1',[row.id]);
      }
      if (!available && mapped) {
        const alert=await client.query(`INSERT INTO ticket_routing_alerts(ticket_id,reason,owner_group_id)
          VALUES($1,'NO_POSITION_COVERAGE',$2) ON CONFLICT(ticket_id) DO UPDATE SET reason='NO_POSITION_COVERAGE',
          owner_group_id=EXCLUDED.owner_group_id,opened_at=CASE WHEN ticket_routing_alerts.resolved_at IS NOT NULL THEN now() ELSE ticket_routing_alerts.opened_at END,
          last_checked_at=now(),resolved_at=NULL
          WHERE ticket_routing_alerts.resolved_at IS NOT NULL OR ticket_routing_alerts.reason<>'NO_POSITION_COVERAGE' RETURNING ticket_id`,[row.id,group]);
        if(alert.rowCount)await record(client,row,'OWNERSHIP_ESCALATION_REQUIRED',{reason:'NO_POSITION_COVERAGE',ownerGroupId:group},row.status,row.status);
        await client.query('UPDATE ticket_routing_alerts SET last_checked_at=now() WHERE ticket_id=$1',[row.id]);
      }
      if (!available && !mapped) {
        const visited = new Set<string>([group]);
        while (true) {
          const next = (await client.query<{ fallback_group_id:string|null }>(
            'SELECT fallback_group_id FROM support_groups WHERE id=$1',[group])).rows[0]?.fallback_group_id;
          if (!next || visited.has(next)) break;
          visited.add(next);
          group = next;
          if (await groupAvailable(group)) break;
        }
        if (!(await groupAvailable(group))) {
          const existing = await client.query<{ resolved_at:Date|null }>(
            'SELECT resolved_at FROM ticket_routing_alerts WHERE ticket_id=$1 FOR UPDATE',[row.id]);
          if (existing.rowCount) await client.query(`UPDATE ticket_routing_alerts SET owner_group_id=$2,
            opened_at=CASE WHEN resolved_at IS NOT NULL THEN now() ELSE opened_at END,
            last_checked_at=now(),resolved_at=NULL WHERE ticket_id=$1`,[row.id,row.owner_group_id]);
          else await client.query(`INSERT INTO ticket_routing_alerts(ticket_id,reason,owner_group_id)
            VALUES ($1,'NO_ACTIVE_FALLBACK',$2)`,[row.id,row.owner_group_id]);
          if (!existing.rowCount || existing.rows[0]?.resolved_at) await record(client,row,'OWNERSHIP_ESCALATION_REQUIRED',{
            reason:'NO_ACTIVE_FALLBACK',ownerGroupId:row.owner_group_id,
          },row.status,row.status);
          group = row.owner_group_id;
        }
      }
      const moved = group !== row.owner_group_id;
      if (!moved && available && ownerQualified) await client.query('UPDATE ticket_routing_alerts SET resolved_at=now() WHERE ticket_id=$1 AND resolved_at IS NULL',[row.id]);
      if (!moved && ownerValid && targetValid) continue;
      const updated = await client.query(`UPDATE tickets SET owner_group_id=$2,assignee_id=$3,pending_group_id=NULL,pending_assignee_id=NULL,
        assignment_kind=NULL,assignment_state=CASE WHEN pending_assignee_id IS NOT NULL THEN 'INVALIDATED' ELSE assignment_state END,
        assignment_due_at=NULL,assignment_offered_at=NULL,assignment_policy_version_id=NULL,
        version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,group,moved ? null : ownerValid ? row.assignee_id : null]);
      await record(client,updated.rows[0],'OWNERSHIP_RECOVERED',{
        reason:moved ? 'OWNER_GROUP_UNAVAILABLE' : ownerValid ? 'HANDOVER_TARGET_UNAVAILABLE' : 'ASSIGNEE_UNAVAILABLE',
        oldOwnerGroupId:row.owner_group_id,oldAssigneeId:row.assignee_id,oldPendingAssigneeId:row.pending_assignee_id,
      },row.status,row.status,row);
      if (moved) await client.query('UPDATE ticket_routing_alerts SET resolved_at=now() WHERE ticket_id=$1 AND resolved_at IS NULL',[row.id]);
    }
    await client.query('DELETE FROM auth_sessions WHERE employee_id IN (SELECT id FROM employees WHERE NOT active)');
  });
}

async function expireAssignments() {
  await transaction(async client=>{
    const rows=await client.query(`SELECT * FROM tickets WHERE pending_assignee_id IS NOT NULL
      AND assignment_due_at<=now() AND status NOT IN ('CLOSED','CANCELLED','REJECTED')
      ORDER BY assignment_due_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`);
    for (const row of rows.rows) {
      const updated=await client.query(`UPDATE tickets SET pending_group_id=NULL,pending_assignee_id=NULL,
        assignment_kind=NULL,assignment_state='EXPIRED',assignment_due_at=NULL,assignment_offered_at=NULL,
        assignment_policy_version_id=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[row.id]);
      await record(client,updated.rows[0],'ASSIGNMENT_EXPIRED',{
        reason:'CANDIDATE_DID_NOT_ACCEPT',assignmentKind:row.assignment_kind,
        targetGroupId:row.pending_group_id,targetAssigneeId:row.pending_assignee_id,
        assignmentPolicyVersionId:row.assignment_policy_version_id,assignmentDueAt:row.assignment_due_at,
      },row.status,row.status,row);
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
    const result = await client.query(`SELECT t.*,s.cycle,s.priority AS sla_priority,s.calendar_snapshot,s.started_at,s.responded_at,s.completed_at,s.paused_at,s.paused_minutes,s.response_target,s.resolution_target,clock_timestamp() AS clock
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
      const end = row.completed_at ?? row.clock;
      const response = serviceMinutes(row.started_at,row.responded_at ?? end,row.calendar_snapshot,row.sla_priority === 'P1');
      const resolution = serviceMinutes(row.started_at,end,row.calendar_snapshot,row.sla_priority === 'P1')-row.paused_minutes
        -(row.paused_at ? serviceMinutes(row.paused_at,end,row.calendar_snapshot,row.sla_priority === 'P1') : 0);
      for (const kind of [response > row.response_target ? 'RESPONSE_BREACH' : '',resolution > row.resolution_target ? 'RESOLUTION_BREACH' : ''].filter(Boolean)) {
        const signal = await client.query('INSERT INTO sla_signals(ticket_id,cycle,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING kind',[row.id,row.cycle,kind]);
        if (signal.rowCount) await record(client,row,'SLA_BREACH',{ cycle:row.cycle,kind },row.status,row.status);
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
  try {
    if (ticks++ % 15 === 0) { await recoverOwnership(); await expireAssignments(); await priorityReviewTimers(); await maintainRequestApprovals(db); await maintainRequestFulfillments(db); await maintainFulfillmentAttention(db,fulfillmentReminders); await timers(); }
    if(approvalProvider)for(let i=0;i<5&&!stopped;i++)if(!await processNextRequestApproval(db,approvalProvider))break;
    if(approvalProvider&&process.env.ENABLE_MANUAL_REQUEST_DELIVERY==='true')
      for(let i=0;i<5&&!stopped;i++)if(!await processNextRequestDelivery(db,approvalProvider))break;
    await expand();
    await refreshFulfillmentNotificationAudiences(db);
    for (let i=0;i<10 && !stopped;i++) await deliver();
    await writeFile('/tmp/itsm-worker-heartbeat', String(Date.now()), { mode:0o600 });
  }
  catch { console.error('ITSM worker cycle failed; retrying without logging payloads'); }
  finally { if (!stopped) timer = setTimeout(() => { void tick(); },2000); else await db.end(); }
}
function shutdown() { stopped=true; if (timer) { clearTimeout(timer); void db.end(); } }
process.once('SIGTERM',shutdown); process.once('SIGINT',shutdown);
console.log(`ITSM worker started; notification mode: ${mode}`);
void tick();
