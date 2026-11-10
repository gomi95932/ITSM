import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { serviceMinutes } from '@itsm/contracts';

const db = new Pool({ host:process.env.DB_HOST ?? 'db',database:process.env.DB_NAME ?? 'itsm',user:process.env.DB_USER ?? 'itsm',password:process.env.DB_PASSWORD,
  connectionTimeoutMillis:5000,statement_timeout:30000 });
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let access: { token:string; expires:number } | undefined;
const mode = process.env.NOTIFICATION_MODE ?? 'disabled';

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
    const result = await client.query('SELECT id,ticket_id FROM outbox_events WHERE expanded_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED');
    for (const event of result.rows) {
      await client.query(`INSERT INTO notification_deliveries(outbox_id,employee_id)
        SELECT $1,e.id FROM employees e JOIN tickets t ON t.id=$2 WHERE e.active AND (e.id=t.requester_id OR EXISTS
          (SELECT 1 FROM group_memberships m WHERE m.employee_id=e.id AND m.group_id=t.owner_group_id)) ON CONFLICT DO NOTHING`,[event.id,event.ticket_id]);
      await client.query("UPDATE outbox_events SET expanded_at=now(),state='EXPANDED' WHERE id=$1",[event.id]);
    }
  });
}

async function deliver() {
  if (mode === 'disabled') return;
  await transaction(async client => {
    const result = await client.query(`SELECT d.*,t.id AS ticket_id,t.number,t.requester_id,t.owner_group_id,e.action,e.detail,e.to_status,e.id AS event_id
      FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id JOIN ticket_events e ON e.id=o.event_id JOIN tickets t ON t.id=o.ticket_id
      WHERE d.state IN ('PENDING','SENDING') AND d.next_at<=now() ORDER BY d.next_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`);
    const row = result.rows[0]; if (!row) return;
    const recipient = await client.query(`SELECT e.active,l.ding_user_id,EXISTS(SELECT 1 FROM group_memberships WHERE employee_id=e.id AND group_id=$3) AS member
      FROM employees e LEFT JOIN identity_links l ON l.employee_id=e.id AND l.corp_id=$2 WHERE e.id=$1`,[row.employee_id,process.env.DINGTALK_CORP_ID ?? '',row.owner_group_id]);
    const user = recipient.rows[0];
    if (!user?.active || (row.employee_id !== row.requester_id && !user.member)) {
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
        if (row.action === 'ACCEPT' && row.employee_id === row.requester_id)
          await client.query('UPDATE sla_cycles SET responded_at=now() WHERE ticket_id=$1 AND cycle=1 AND responded_at IS NULL',[row.ticket_id]);
      } else {
        const base = new URL(process.env.ITSM_PUBLIC_URL ?? '');
        if (base.protocol !== 'https:') throw new Error('HTTPS_DEEP_LINK_REQUIRED');
        base.hash = `/tickets/${row.ticket_id}`;
        const reply = ['ACCEPT','REQUEST_INFO','RESOLVE'].includes(row.action) ? String(row.detail.comment ?? '').slice(0,500) : '';
        const data = await provider('asyncsend_v2',{ agent_id:process.env.DINGTALK_AGENT_ID,userid_list:user.ding_user_id,to_all_user:false,
          msg:{ msgtype:'link',link:{ title:`IT 服务台 · ${row.number}`,text:`${row.to_status}${reply ? `\n${reply}` : ''}`,messageUrl:base.toString(),picUrl:'' } } });
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

async function record(client:PoolClient,row:any,action:string,detail:object,from:string,to:string) {
  const event = randomUUID(), request = randomUUID();
  await client.query('INSERT INTO ticket_events(id,ticket_id,actor_id,action,from_status,to_status,detail,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[event,row.id,'system:scheduler',action,from,to,JSON.stringify(detail),request]);
  await client.query('INSERT INTO audit_logs(ticket_id,event_id,actor_id,request_id,action,before_value,after_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',[row.id,event,'system:scheduler',request,action,JSON.stringify({ status:from }),JSON.stringify({ status:to,version:row.version })]);
  await client.query('INSERT INTO outbox_events(ticket_id,event_id,kind,payload) VALUES ($1,$2,$3,$4)',[row.id,event,'TICKET_CHANGED',JSON.stringify({ ticketId:row.id,eventId:event })]);
}

async function timers() {
  await transaction(async client => {
    const result = await client.query(`SELECT t.*,s.cycle,s.calendar_snapshot,s.started_at,s.responded_at,s.completed_at,s.paused_at,s.paused_minutes,s.response_target,s.resolution_target,now() AS clock
      FROM tickets t JOIN sla_cycles s ON s.ticket_id=t.id AND s.cycle=(SELECT max(cycle) FROM sla_cycles WHERE ticket_id=t.id)
      WHERE t.status NOT IN ('CLOSED','CANCELLED','REJECTED') ORDER BY t.sla_checked_at NULLS FIRST,t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`);
    for (const row of result.rows) {
      await client.query('UPDATE tickets SET sla_checked_at=now() WHERE id=$1',[row.id]);
      const closeHours = Number(process.env.AUTO_CLOSE_HOURS ?? 72);
      if (row.status === 'PENDING_CONFIRMATION' && closeHours > 0 && row.clock.getTime()-row.updated_at.getTime() >= closeHours*3600000) {
        const updated = await client.query("UPDATE tickets SET status='CLOSED',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id]);
        await record(client,updated.rows[0],'AUTO_CLOSE',{ reason:`待确认超过 ${closeHours} 小时自动关闭` },row.status,'CLOSED');
        continue;
      }
      const end = row.completed_at ?? row.clock;
      const response = serviceMinutes(row.started_at,row.responded_at ?? end,row.calendar_snapshot,row.priority === 'P1');
      const resolution = serviceMinutes(row.started_at,end,row.calendar_snapshot,row.priority === 'P1')-row.paused_minutes
        -(row.paused_at ? serviceMinutes(row.paused_at,end,row.calendar_snapshot,row.priority === 'P1') : 0);
      for (const kind of [response > row.response_target ? 'RESPONSE_BREACH' : '',resolution > row.resolution_target ? 'RESOLUTION_BREACH' : ''].filter(Boolean)) {
        const signal = await client.query('INSERT INTO sla_signals(ticket_id,cycle,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING kind',[row.id,row.cycle,kind]);
        if (signal.rowCount) await record(client,row,'SLA_BREACH',{ cycle:row.cycle,kind },row.status,row.status);
      }
    }
    await client.query("DELETE FROM auth_sessions WHERE expires_at<now()-interval '1 day'");
    await client.query("DELETE FROM auth_code_uses WHERE created_at<now()-interval '1 day'");
    await client.query('DELETE FROM voice_drafts WHERE expires_at<now()');
    await client.query("DELETE FROM intake_rate_limits WHERE bucket<now()-interval '1 day'");
  });
}
let ticks = 0;
async function tick() {
  try {
    if (ticks++ % 15 === 0) await timers();
    await expand();
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
