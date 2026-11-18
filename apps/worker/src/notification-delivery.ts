import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { notificationRecipients } from './notification-audience.js';
import { notificationLink } from './notification-message.js';

type Delivery = {
  id: string; event_id: string; employee_id: string; requester_id: string;
  ticket_id: string; number: string; action: string; to_status: string;
  state: string; attempts: number; provider_task_id: string | null; provider_recipient_hash: string | null;
};
type ProviderResult = {
  task_id?: unknown;
  send_result?: {
    read_user_id_list?: unknown; unread_user_id_list?: unknown;
    failed_user_id_list?: unknown; forbidden_user_id_list?: unknown; invalid_user_id_list?: unknown;
  };
};
type Options = {
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  mode: string; production: boolean; live: boolean; corpId: string; agentId: string; publicUrl: string;
  provider: (operation: 'asyncsend_v2' | 'getsendresult', body: object) => Promise<ProviderResult>;
};

export class NotificationBeforeSendError extends Error {
  constructor(readonly code: 'DINGTALK_NOT_CONFIGURED' | 'TOKEN_FAILED') { super(code); }
}

export function parseNotificationResponse(text: string): ProviderResult & { errcode?: number } {
  return JSON.parse(text, (key: string, value: unknown, context?: { source: string }) => {
    // DingTalk may return a 64-bit task ID as a JSON number.
    if (key==='task_id' && typeof value==='number' && context && /^[1-9][0-9]{0,19}$/.test(context.source))
      return context.source;
    return value;
  });
}

function isProviderId(value: unknown): value is string {
  return typeof value==='string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value)<=9223372036854775807n;
}

export function serializeNotificationRequest(body: object): string {
  const rawJSON = (JSON as typeof JSON & { rawJSON: (value: string) => unknown }).rawJSON;
  return JSON.stringify(body, (key, value: unknown) => {
    if (key!=='agent_id' && key!=='task_id') return value;
    if (!isProviderId(value)) throw new Error('INVALID_DINGTALK_ID');
    return rawJSON(value);
  });
}

const deliverySelect = `SELECT d.*,t.id AS ticket_id,t.number,t.requester_id,e.action,e.to_status,e.id AS event_id
  FROM notification_deliveries d JOIN outbox_events o ON o.id=d.outbox_id
  JOIN ticket_events e ON e.id=o.event_id JOIN tickets t ON t.id=o.ticket_id`;

async function recordState(client: PoolClient, id: string, state: string, error: string | null) {
  await client.query('UPDATE notification_deliveries SET state=$2,last_error=$3,updated_at=clock_timestamp() WHERE id=$1',
    [id,state,error]);
}

async function recipient(client: PoolClient, row: Delivery, corpId: string) {
  if (!(await notificationRecipients(client,row.event_id,row.employee_id)).length) return { authorized:false, userId:null };
  const employee = await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[row.employee_id]);
  if (!employee.rowCount) return { authorized:false, userId:null };
  const result = await client.query<{ding_user_id:string}>(`SELECT ding_user_id FROM identity_links
    WHERE employee_id=$1 AND corp_id=$2 FOR SHARE`,[row.employee_id,corpId]);
  return { authorized:true, userId:result.rows[0]?.ding_user_id ?? null };
}

function recipientHash(options: Options, userId: string) {
  return createHash('sha256').update(JSON.stringify([options.corpId,options.agentId,userId])).digest('hex');
}

async function retryLater(client: PoolClient, row: Delivery, error: string) {
  const attempts = row.attempts+1;
  const state = attempts >= (row.provider_task_id ? 20 : 5) ? 'DEAD' : row.provider_task_id ? 'SENDING' : 'PENDING';
  await client.query(`UPDATE notification_deliveries SET state=$2,attempts=$3,last_error=$4,
    provider_recipient_hash=CASE WHEN provider_task_id IS NULL THEN NULL ELSE provider_recipient_hash END,
    next_at=clock_timestamp()+($5 * interval '1 second'),updated_at=clock_timestamp() WHERE id=$1`,
  [row.id,state,attempts,error,Math.min(3600,5 * 2 ** attempts)]);
}

async function poll(client: PoolClient, row: Delivery, userId: string, options: Options) {
  let result: ProviderResult;
  try { result = await options.provider('getsendresult',{agent_id:options.agentId,task_id:row.provider_task_id}); }
  catch { return retryLater(client,row,'PROVIDER_UNAVAILABLE'); }
  const receipt = result.send_result;
  const includesRecipient = (list: unknown) => Array.isArray(list) && list.includes(userId);
  const excluded = [receipt?.failed_user_id_list,receipt?.forbidden_user_id_list,receipt?.invalid_user_id_list].some(includesRecipient);
  const delivered = [receipt?.read_user_id_list,receipt?.unread_user_id_list].some(includesRecipient);
  if (excluded || !delivered) return retryLater(client,row,'DELIVERY_NOT_CONFIRMED');
  await recordState(client,row.id,'DELIVERED',null);
  if (['ACCEPT','ACCEPT_HANDOVER','ACCEPT_OFFER'].includes(row.action) && row.employee_id===row.requester_id)
    await client.query('UPDATE sla_cycles SET responded_at=now() WHERE ticket_id=$1 AND cycle=1 AND responded_at IS NULL',[row.ticket_id]);
}

export async function deliverNotification(options: Options): Promise<boolean> {
  if (options.mode==='disabled') return false;
  const selected = await options.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const row = (await client.query<Delivery>(`${deliverySelect}
      WHERE d.state IN ('PENDING','SENDING','DISPATCHING') AND d.next_at<=clock_timestamp()
      ORDER BY (o.kind='P1_ALERT') DESC,d.next_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`)).rows[0];
    if (!row) return { processed:false };
    const processed = { processed:true };
    if (row.state==='DISPATCHING') {
      await recordState(client,row.id,'REVIEW_REQUIRED','DINGTALK_SEND_UNCONFIRMED');
      return processed;
    }
    const target = await recipient(client,row,options.corpId);
    if (!target.authorized) {
      await recordState(client,row.id,'SKIPPED','RECIPIENT_NO_LONGER_AUTHORIZED');
      return processed;
    }
    if (row.provider_task_id && (!target.userId || row.provider_recipient_hash!==recipientHash(options,target.userId))) {
      await recordState(client,row.id,'REVIEW_REQUIRED','PROVIDER_RECIPIENT_CHANGED');
      return processed;
    }
    if (options.mode==='fake' && !options.production && !row.provider_task_id) {
      await client.query("UPDATE notification_deliveries SET state='SIMULATED',attempts=attempts+1,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1",[row.id]);
      return processed;
    }
    if (options.mode!=='dingtalk' || !options.live || !options.corpId || !isProviderId(options.agentId)) {
      await retryLater(client,row,'LIVE_DELIVERY_DISABLED');
      return processed;
    }
    if (!target.userId) {
      await retryLater(client,row,'RECIPIENT_NOT_LINKED');
      return processed;
    }
    if (row.provider_task_id) {
      await poll(client,row,target.userId,options);
      return processed;
    }
    let link: ReturnType<typeof notificationLink>;
    try { link = notificationLink(options.publicUrl,row); }
    catch {
      await retryLater(client,row,'HTTPS_DEEP_LINK_REQUIRED');
      return processed;
    }
    await client.query(`UPDATE notification_deliveries SET state='DISPATCHING',provider_recipient_hash=$2,
      next_at=clock_timestamp()+interval '60 seconds',last_error=NULL,updated_at=clock_timestamp() WHERE id=$1`,
    [row.id,recipientHash(options,target.userId)]);
    return { ...processed, id:row.id, link };
  });
  if (!selected.id || !selected.link) return selected.processed;
  const { id, link } = selected;

  // Commit the checkpoint before sending so a crash cannot return the item to the send queue.
  await options.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const row = (await client.query<Delivery>(`${deliverySelect} WHERE d.id=$1 AND d.state='DISPATCHING'
      AND d.next_at>clock_timestamp() FOR UPDATE OF d SKIP LOCKED`,[id])).rows[0];
    if (!row) return;
    await client.query('SELECT id FROM tickets WHERE id=$1 FOR SHARE',[row.ticket_id]);
    const target = await recipient(client,row,options.corpId);
    if (!target.authorized || !target.userId || row.provider_recipient_hash!==recipientHash(options,target.userId)) {
      await recordState(client,id,'SKIPPED','RECIPIENT_NO_LONGER_AUTHORIZED');
      return;
    }
    let data: ProviderResult;
    try {
      data = await options.provider('asyncsend_v2',{ agent_id:options.agentId,userid_list:target.userId,to_all_user:false,
        msg:{msgtype:'link',link} });
    } catch (error) {
      if (error instanceof NotificationBeforeSendError) await retryLater(client,row,error.code);
      else await recordState(client,id,'REVIEW_REQUIRED','DINGTALK_SEND_UNCONFIRMED');
      return;
    }
    const taskId = data.task_id;
    const exactTaskId = typeof taskId==='number' && Number.isSafeInteger(taskId) ? String(taskId) : taskId;
    if (!isProviderId(exactTaskId)) {
      await recordState(client,id,'REVIEW_REQUIRED','DINGTALK_SEND_UNCONFIRMED');
      return;
    }
    await client.query(`UPDATE notification_deliveries SET state='SENDING',provider_task_id=$2,attempts=0,
      next_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp() WHERE id=$1`,[id,exactTaskId]);
  });
  return true;
}
